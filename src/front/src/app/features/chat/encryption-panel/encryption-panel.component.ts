import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LucideAngularModule, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Chat } from '../../../core/models/chat.model';
import { ChatRoster } from '../../../core/models/crypto.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { KeyChangeStateService } from '../../../core/services/key-change-state.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { rosterMatchesMembers } from '../roster-commitment';
import { classifySafetyError } from '../safety-number/safety-number.component';

export type MemberKeyStatus = 'checking' | 'verified' | 'unverified' | 'changed' | 'no-keys' | 'error';

export const STATUS_LABELS: Record<MemberKeyStatus, string> = {
    checking: 'Checking…',
    verified: 'Verified',
    unverified: 'Not verified',
    changed: 'Key changed',
    'no-keys': 'No published key yet',
    error: 'Could not check',
};

/**
 * The Encryption section of chat info for a group or channel: the conversation's encryption status
 * and, for a group, each member's key status with a way into that person's safety number (the host
 * opens it inline). A group has no single safety number, so none is shown here.
 */
@Component({
    selector: 'app-encryption-panel',
    imports: [LucideAngularModule, AvatarComponent],
    templateUrl: './encryption-panel.component.html',
    styleUrl: './encryption-panel.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EncryptionPanelComponent {
    private readonly chatApi = inject(ChatApiService);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly keyStore = inject(KeyStoreService);
    private readonly trust = inject(TrustStoreService);
    private readonly keyChange = inject(KeyChangeStateService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);
    private readonly store = inject(ChatStoreService);

    readonly chatId = input.required<string>();
    /** The person whose safety number the user asked to see. */
    readonly safetyRequested = output<string>();

    readonly chat = signal<Chat | null>(null);
    readonly roster = signal<ChatRoster | null>(null);
    readonly loading = signal(true);
    readonly error = signal<string | null>(null);
    readonly statuses = signal<Record<string, MemberKeyStatus>>({});

    readonly isChannel = computed(() => this.chat()?.chat_type === 'channel');
    readonly verificationError = this.store.memberVerificationError;

    /**
     * The header's claim, from this panel's own check of the roster it fetched — the same check as
     * chat-info's `memberSetVerified`. Null when no roster could be fetched: nothing was checked, so
     * the header says so instead of claiming a match. The send path's alarm (`verificationError`)
     * still wins over a passing check, since it may have seen a roster this panel did not.
     *
     * The members listed here are the chat's participants, so a passing check also requires that the
     * roster names nobody outside them (`rosterMatchesMembers`): a roster can agree with its own
     * commitment while carrying a device for someone this list does not show.
     */
    readonly memberSetCheck = computed<boolean | null>(() => {
        const roster = this.roster();
        const chat = this.chat();
        if (!roster || !chat) {
            return null;
        }
        return rosterMatchesMembers(
            roster,
            chat.participants.map((p) => p.user_id)
        );
    });
    readonly epoch = computed(() => this.roster()?.current_epoch ?? this.store.chatKeys()?.current_epoch ?? null);
    /** When the current epoch began, i.e. the last key rotation, when the keys are loaded. */
    readonly rotatedAt = computed(() => {
        const keys = this.store.chatKeys();
        return keys?.epochs.find((e) => e.epoch === keys.current_epoch)?.created_at ?? null;
    });

    readonly members = computed(() => {
        const me = this.session.user()?.id;
        const chatId = this.chatId();
        return (this.chat()?.participants ?? [])
            .filter((p) => p.user_id !== me)
            .map((p) => {
                const identity = this.directory.lookup(p.user_id);
                return {
                    userId: p.user_id,
                    name: identity.name,
                    avatarUrl: identity.avatarUrl,
                    status: this.blocked(me, p.user_id, chatId)
                        ? ('changed' as const)
                        : (this.statuses()[p.user_id] ?? ('checking' as MemberKeyStatus)),
                };
            });
    });

    readonly labels = STATUS_LABELS;
    readonly okIcon = ShieldCheck;
    readonly alertIcon = ShieldAlert;
    readonly offIcon = ShieldOff;
    readonly uncheckedIcon = ShieldQuestion;

    constructor() {
        effect(() => void this.load(this.chatId()));
    }

    /**
     * Bumped by every `load`. The panel keeps one instance across chat switches, so a response that
     * arrives after the user moved on must not be written under the chat now shown.
     */
    private generation = 0;

    private async load(chatId: string): Promise<void> {
        const generation = ++this.generation;
        const current = () => generation === this.generation;

        this.loading.set(true);
        this.error.set(null);
        // Nothing from the previous chat survives: its roster would be read as this chat's.
        this.chat.set(null);
        this.roster.set(null);
        this.statuses.set({});
        try {
            const chat = await firstValueFrom(this.chatApi.getChat(chatId));
            if (!current()) {
                return;
            }
            if (chat.chat_type === 'channel') {
                this.chat.set(chat);
                return;
            }
            let roster: ChatRoster | null;
            try {
                roster = await firstValueFrom(this.cryptoApi.getRoster(chatId));
            } catch {
                roster = null;
            }
            if (!current()) {
                return;
            }
            // Set together, so the check never pairs one chat's members with another's roster.
            this.chat.set(chat);
            this.roster.set(roster);
            this.loading.set(false);
            await this.checkMembers(chat, current);
        } catch {
            if (current()) {
                this.error.set("Could not load this conversation's encryption details.");
            }
        } finally {
            if (current()) {
                this.loading.set(false);
            }
        }
    }

    /** Each member's number is derived locally (never taken from the server) and compared with what was verified before. */
    private async checkMembers(chat: Chat, current: () => boolean): Promise<void> {
        const me = this.session.user()?.id;
        if (!me) {
            return;
        }
        for (const participant of chat.participants) {
            if (participant.user_id === me) {
                continue;
            }
            let status: MemberKeyStatus;
            try {
                const { number } = await this.keyStore.computeSafetyNumber(participant.user_id);
                status = this.trust.stateFor(me, participant.user_id, number).kind;
            } catch (error) {
                status = classifySafetyError(error) === 'peer-no-keys' ? 'no-keys' : 'error';
            }
            if (!current()) {
                return;
            }
            this.statuses.update((all) => ({ ...all, [participant.user_id]: status }));
        }
    }

    /**
     * Sending in this chat is blocked on this member's number: this chat holds a refusal for them, or
     * the send path's roster derived a number that differs from the confirmed one. Overrides the
     * lookup-derived status, as the safety-number screen does — a server that equivocates can answer
     * the batch lookup with the old keys while the roster carries new ones, and the badge would then
     * read "Verified" for exactly the member sending is refused on. Reactive.
     */
    private blocked(me: string | undefined, userId: string, chatId: string): boolean {
        return (
            !!me &&
            (this.keyChange.refusalFor(chatId, me, userId) !== null ||
                this.keyChange.blockingNumber(me, userId, chatId) !== null)
        );
    }

    openMember(userId: string): void {
        this.safetyRequested.emit(userId);
    }
}
