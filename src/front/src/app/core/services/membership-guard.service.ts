import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Chat, ChatParticipant } from '../models/chat.model';
import { ChatApiService } from './chat-api.service';
import { MembershipMismatchError, MembershipUnconfirmedError } from './crypto-errors';
import { DirectoryService } from './directory.service';
import { KeyStoreService } from './key-store.service';
import { SessionService } from './session.service';
import { bindStorageKey } from './storage-sync';

/** `<own user id>:<chat id>` -> the counterpart of that private chat, as first seen. */
const PEER_PIN_KEY = 'ns.private_peers';

/** `<own user id>:<chat id>` -> the encrypted type that chat was first seen as. */
const ENCRYPTED_CHATS_KEY = 'ns.encrypted_chats';

/** The chat types whose messages are sealed. A channel's posts are signed and readable. */
export type EncryptedChatType = 'private' | 'group';

/**
 * A chat this client has seen as encrypted is now reported as a channel. Posting would publish the
 * user's message signed and readable by the server, so it is refused as a membership alarm.
 */
export function relabelledAsChannel(was: EncryptedChatType): MembershipMismatchError {
    return new MembershipMismatchError(
        `Member verification failed: this was ${was === 'private' ? 'a private chat' : 'an encrypted group'} and ` +
            'is now reported as a channel. Refusing to post it in the clear.'
    );
}

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
    private readonly pins: Record<string, string> = readStringMap(PEER_PIN_KEY) ?? {};

    /**
     * Chats this account has seen as private or group with encryption, kept like the pins (read
     * once, then merged from other tabs; entries this tab could not persist stay). A group is not
     * pinned — its members legitimately change — so without this a server could relabel one as a
     * channel and the next message would go out as a readable post with no alarm at all.
     */
    private readonly encrypted: Record<string, string> = readStringMap(ENCRYPTED_CHATS_KEY, isEncryptedType) ?? {};

    constructor() {
        // Ours win for any chat both tabs recorded: neither record is ever replaced once held, and a
        // cleared storage (another tab's `localStorage.clear()`) takes nothing away from this tab.
        bindStorageKey(PEER_PIN_KEY, () => Object.assign(this.pins, { ...readStringMap(PEER_PIN_KEY), ...this.pins }));
        bindStorageKey(ENCRYPTED_CHATS_KEY, () =>
            Object.assign(this.encrypted, { ...readStringMap(ENCRYPTED_CHATS_KEY, isEncryptedType), ...this.encrypted })
        );
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

        if (chat.chat_type === 'channel') {
            const was = this.encryptedTypeOf(chat.id);
            if (was) {
                throw relabelledAsChannel(was);
            }
            return;
        }
        if (pinned && chat.chat_type !== 'private') {
            throw new MembershipMismatchError(
                `Member verification failed: this was a private chat with one person and is now reported as a ` +
                    `${chat.chat_type}. Refusing to distribute keys.`
            );
        }
        if (chat.chat_type === 'group') {
            // Recorded before anything is sealed for it, so it can never be posted to in the clear.
            this.noteEncrypted(chat.id, 'group');
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

    /**
     * Remember that this chat was seen as an encrypted `type` (for the signed-in account). Called
     * when a chat's keys load and before anything is sealed for it. Never replaced once recorded.
     */
    noteEncrypted(chatId: string, type: EncryptedChatType): void {
        const me = this.session.user()?.id;
        const key = me ? pinKey(me, chatId) : null;
        if (!key || this.encrypted[key]) {
            return;
        }
        const stored = readStringMap(ENCRYPTED_CHATS_KEY, isEncryptedType);
        this.encrypted[key] = stored?.[key] ?? type;
        try {
            localStorage.setItem(
                ENCRYPTED_CHATS_KEY,
                JSON.stringify({ ...(stored ?? {}), [key]: this.encrypted[key] })
            );
        } catch {
            // Held in memory for this tab; it still refuses here, just not after a reload.
        }
    }

    /**
     * `noteEncrypted` for a whole chat list, with one storage read and at most one write.
     *
     * Called whenever the list loads. Recording a chat only once its keys had loaded left every chat
     * the user had not opened in this browser unrecorded, so the server could report such a private
     * chat or group as a channel and the first message typed into it would go out as a readable
     * post. Channels are skipped; a chat already recorded keeps its first type.
     *
     * First sight is still the server's word (trust on first use), and the record lives in
     * localStorage - see `docs/tech-debt.md` section 14.
     */
    noteEncryptedChats(chats: readonly Pick<Chat, 'id' | 'chat_type'>[]): void {
        const me = this.session.user()?.id;
        if (!me) {
            return;
        }
        let stored: Record<string, string> | null | undefined;
        const added: Record<string, string> = {};
        for (const chat of chats) {
            const key = pinKey(me, chat.id);
            if (!key || !isEncryptedType(chat.chat_type) || this.encrypted[key]) {
                continue;
            }
            stored ??= readStringMap(ENCRYPTED_CHATS_KEY, isEncryptedType);
            // A record another tab wrote first wins, exactly as in `noteEncrypted`.
            this.encrypted[key] = stored?.[key] ?? chat.chat_type;
            added[key] = this.encrypted[key];
        }
        if (Object.keys(added).length === 0) {
            return;
        }
        try {
            localStorage.setItem(ENCRYPTED_CHATS_KEY, JSON.stringify({ ...(stored ?? {}), ...added }));
        } catch {
            // Held in memory for this tab; it still refuses here, just not after a reload.
        }
    }

    /**
     * The encrypted type this chat was seen as — a pinned private chat counts — or null when it has
     * only ever been seen as a channel (or never seen). Such a chat must never get a readable post.
     */
    encryptedTypeOf(chatId: string): EncryptedChatType | null {
        const me = this.session.user()?.id;
        const key = me ? pinKey(me, chatId) : null;
        if (!me || !key) {
            return null;
        }
        if (this.pinnedPeer(me, chatId) !== null) {
            return 'private';
        }
        // A record another tab wrote whose event has not arrived yet still counts (fail closed).
        const seen = this.encrypted[key] ?? readStringMap(ENCRYPTED_CHATS_KEY, isEncryptedType)?.[key];
        if (seen && isEncryptedType(seen)) {
            this.encrypted[key] = seen;
            return seen;
        }
        return null;
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
        const existing = this.pins[key] ?? readStringMap(PEER_PIN_KEY)?.[key];
        if (existing) {
            this.pins[key] = existing;
            return existing;
        }
        this.pins[key] = peerId;
        try {
            localStorage.setItem(
                PEER_PIN_KEY,
                JSON.stringify({ ...(readStringMap(PEER_PIN_KEY) ?? {}), [key]: peerId })
            );
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

function isEncryptedType(value: string): value is EncryptedChatType {
    return value === 'private' || value === 'group';
}

/**
 * A stored `string -> string` map, keeping only non-empty string values that pass `accept`; null
 * when storage cannot be read at all. Tampered entries are dropped, never trusted.
 */
function readStringMap(
    storageKey: string,
    accept: (value: string) => boolean = () => true
): Record<string, string> | null {
    try {
        const raw = localStorage.getItem(storageKey);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return {};
        }
        const valid: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && value && accept(value)) {
                valid[key] = value;
            }
        }
        return valid;
    } catch {
        return null;
    }
}
