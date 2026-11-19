import { DestroyRef, inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Chat, ChatParticipant } from '../models/chat.model';
import { ChatApiService } from './chat-api.service';
import { MembershipMismatchError, MembershipUnconfirmedError } from './crypto-errors';
import { DirectoryService } from './directory.service';
import { KeyStoreService } from './key-store.service';
import { SessionService } from './session.service';

/** `<own user id>:<chat id>` -> the counterpart of that private chat, as first seen. */
const PEER_PIN_KEY = 'ns.private_peers';

/** Called with the participant list a group publish was checked against, before anything is wrapped. */
export type GroupMembersSink = (chatId: string, participants: ChatParticipant[]) => void;

/**
 * Decides who may appear in a chat's roster, independently of the roster, and tells
 * `KeyStoreService` (`expectMembers`) before anything is sealed for that chat.
 *
 * - private — exactly {me, peer}. The peer is pinned the first time the chat is seen with a
 *   well-formed participant list (or when this client created the chat), and the pin is persisted,
 *   so neither a later answer nor a reload lets the server name someone else. A chat that
 *   contradicts its pin — a different counterpart, or the same chat now reported as a group or
 *   channel — is refused with `MembershipMismatchError` (the blocking alarm). A private chat with
 *   no pin and no well-formed list is refused with `MembershipUnconfirmedError`: a retryable
 *   "not sent", not an alarm.
 * - group — the participant list, re-fetched for every publish so a member who joined after the chat
 *   was opened is not refused as an intruder. What it reads is handed to a sink before it is
 *   returned, so the member list shows exactly the set that was checked.
 *
 * Pins are public data (who a chat is with), stored for the same reason as trust records:
 * forgetting one costs the defence, disclosing it costs nothing. Never wiped on logout, keyed per
 * account of ours.
 */
@Injectable({ providedIn: 'root' })
export class MembershipGuardService {
    private readonly keyStore = inject(KeyStoreService);
    private readonly chatApi = inject(ChatApiService);
    private readonly session = inject(SessionService);
    private readonly directory = inject(DirectoryService);

    /**
     * The pins, read from storage once and then kept current by the `storage` listener — not by
     * re-parsing storage on every lookup. Holds pins this tab could not persist, too.
     */
    private readonly pins: Record<string, string> = readPins() ?? {};

    constructor() {
        this.bindStorageEvents();
    }

    /**
     * Register this chat's expected members with the key store, or throw. Synchronous: the caller
     * loads participants first if it needs them (a private chat with a pin needs none).
     */
    register(chat: Chat, onGroupMembers: GroupMembersSink): void {
        const me = this.session.user()?.id;
        if (!me) {
            return;
        }
        const pinned = this.pinnedPeer(me, chat.id);

        if (pinned && chat.chat_type !== 'private') {
            throw new MembershipMismatchError(
                `Member verification failed: this was a private chat with one person and is now reported as a ` +
                    `${chat.chat_type}. Refusing to distribute keys.`
            );
        }
        if (chat.chat_type === 'channel') {
            return;
        }

        if (chat.chat_type === 'group') {
            this.keyStore.expectMembers(chat.id, {
                kind: 'group',
                resolve: () => this.resolveGroupMembers(chat.id, onGroupMembers),
            });
            return;
        }

        const ids = chat.participants.map((p) => p.user_id);
        const peers = ids.filter((id) => id !== me);
        const wellFormed = ids.includes(me) && peers.length === 1;

        if (pinned) {
            // An empty list is "not loaded", not a contradiction: the pin alone is enough to send.
            if (ids.length > 0 && (!wellFormed || peers[0] !== pinned)) {
                throw counterpartMismatch();
            }
            this.keyStore.expectMembers(chat.id, { kind: 'private', selfId: me, peerId: pinned });
            return;
        }
        if (!wellFormed) {
            throw new MembershipUnconfirmedError();
        }
        const pin = this.pinPeer(me, chat.id, peers[0]);
        if (pin !== peers[0]) {
            // Another tab pinned this chat to someone else a moment ago; its pin wins.
            throw counterpartMismatch();
        }
        this.keyStore.expectMembers(chat.id, { kind: 'private', selfId: me, peerId: pin });
    }

    /**
     * Right after `POST /chats/private`: pin the person the user asked to talk to, rather than
     * whoever the response later names. Throws `MembershipMismatchError` when the response already
     * disagrees — not a private chat, participants other than {me, that person}, or a pin (from an
     * earlier open or another tab) naming someone else — so the caller does not open it.
     */
    pinCreatedPrivateChat(chat: Chat, targetUserId: string): void {
        const me = this.session.user()?.id;
        if (!me) {
            return;
        }
        if (chat.chat_type !== 'private') {
            throw new MembershipMismatchError(
                `Member verification failed: a private chat was requested, and the server returned a ` +
                    `${chat.chat_type}. Refusing to open it.`
            );
        }
        const ids = new Set(chat.participants.map((p) => p.user_id));
        if (ids.size > 0 && (ids.size !== 2 || !ids.has(me) || !ids.has(targetUserId))) {
            throw counterpartMismatch();
        }
        if (this.pinPeer(me, chat.id, targetUserId) !== targetUserId) {
            throw counterpartMismatch();
        }
    }

    /** A private pin exists for this chat (for the signed-in account). */
    isPinnedPrivate(chatId: string): boolean {
        const me = this.session.user()?.id;
        return !!me && this.pinnedPeer(me, chatId) !== null;
    }

    /**
     * The counterpart pinned for this private chat, or null. Memory only: other tabs' pins arrive
     * through the `storage` listener.
     */
    pinnedPeer(selfId: string, chatId: string): string | null {
        const key = pinKey(selfId, chatId);
        return key ? (this.pins[key] ?? null) : null;
    }

    /**
     * Pin this private chat's counterpart if none is pinned yet. Never replaces an existing pin — a
     * private chat's counterpart cannot change. Returns the pin in force afterwards.
     */
    pinPeer(selfId: string, chatId: string, peerId: string): string | null {
        const key = pinKey(selfId, chatId);
        if (!key || !peerId) {
            return null;
        }
        // A pin another tab wrote whose event has not arrived yet still wins over ours.
        const existing = this.pins[key] ?? readPins()?.[key];
        if (existing) {
            this.pins[key] = existing;
            return existing;
        }
        this.pins[key] = peerId;
        try {
            localStorage.setItem(PEER_PIN_KEY, JSON.stringify({ ...(readPins() ?? {}), [key]: peerId }));
        } catch {
            // Held in memory for this tab; a reload re-pins from the chat as opened then.
        }
        return peerId;
    }

    /**
     * The group's participant list as the key store checks it at publish time — and, before it is
     * returned, the list the UI shows. A member present only in this response used to receive the
     * chain key while never appearing in the member list or header.
     */
    private async resolveGroupMembers(chatId: string, onGroupMembers: GroupMembersSink): Promise<string[]> {
        const detail = await firstValueFrom(this.chatApi.getChat(chatId));
        if (this.isPinnedPrivate(chatId)) {
            throw new MembershipMismatchError(
                'Member verification failed: this was a private chat with one person and is now reported as a ' +
                    'group. Refusing to distribute keys.'
            );
        }
        onGroupMembers(chatId, detail.participants);
        const ids = detail.participants.map((p) => p.user_id);
        // Names follow; the ids themselves are already on screen through `participants`.
        void this.directory.resolveMissing(ids);
        return ids;
    }

    /** Adopt pins other tabs wrote. Guarded for SSR and for specs that construct with `new`. */
    private bindStorageEvents(): void {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return;
        }
        const listener = (event: StorageEvent): void => {
            if (event.key === PEER_PIN_KEY || event.key === null) {
                // Ours win for any chat both tabs pinned: a pin is never replaced once held.
                Object.assign(this.pins, { ...(readPins() ?? {}), ...this.pins });
            }
        };
        window.addEventListener('storage', listener);
        try {
            inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', listener));
        } catch {
            // Constructed outside an injection context: nothing owns this instance's lifetime.
        }
    }
}

function counterpartMismatch(): MembershipMismatchError {
    return new MembershipMismatchError(
        'Member verification failed: this private chat now names a different person than the one it was ' +
            'opened with. Refusing to distribute keys.'
    );
}

function pinKey(selfId: string, chatId: string): string | null {
    return selfId && chatId ? `${selfId}:${chatId}` : null;
}

function readPins(): Record<string, string> | null {
    try {
        const raw = localStorage.getItem(PEER_PIN_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return {};
        }
        const valid: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && value) {
                valid[key] = value;
            }
        }
        return valid;
    } catch {
        return null;
    }
}
