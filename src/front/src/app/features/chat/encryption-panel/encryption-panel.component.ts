import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LucideAngularModule, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Chat } from '../../../core/models/chat.model';
import { ChatRoster } from '../../../core/models/crypto.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
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
    readonly epoch = computed(() => this.roster()?.current_epoch ?? this.store.chatKeys()?.current_epoch ?? null);
    /** When the current epoch began, i.e. the last key rotation, when the keys are loaded. */
    readonly rotatedAt = computed(() => {
        const keys = this.store.chatKeys();
        return keys?.epochs.find((e) => e.epoch === keys.current_epoch)?.created_at ?? null;
    });

    readonly members = computed(() => {
        const me = this.session.user()?.id;
        return (this.chat()?.participants ?? [])
            .filter((p) => p.user_id !== me)
            .map((p) => {
                const identity = this.directory.lookup(p.user_id);
                return {
                    userId: p.user_id,
                    name: identity.name,
                    avatarUrl: identity.avatarUrl,
                    status: this.statuses()[p.user_id] ?? ('checking' as MemberKeyStatus),
                };
            });
    });

    readonly labels = STATUS_LABELS;
    readonly okIcon = ShieldCheck;
    readonly alertIcon = ShieldAlert;
    readonly offIcon = ShieldOff;

    constructor() {
        effect(() => void this.load(this.chatId()));
    }

    private async load(chatId: string): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        this.statuses.set({});
        try {
            const chat = await firstValueFrom(this.chatApi.getChat(chatId));
            this.chat.set(chat);
            if (chat.chat_type === 'channel') {
                return;
            }
            try {
                this.roster.set(await firstValueFrom(this.cryptoApi.getRoster(chatId)));
            } catch {
                this.roster.set(null);
            }
            this.loading.set(false);
            await this.checkMembers(chat);
        } catch {
            this.error.set("Could not load this conversation's encryption details.");
        } finally {
            this.loading.set(false);
        }
    }

    /** Each member's number is derived locally (never taken from the server) and compared with what was verified before. */
    private async checkMembers(chat: Chat): Promise<void> {
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
                const number = await this.keyStore.computeSafetyNumber(participant.user_id);
                status = this.trust.stateFor(me, participant.user_id, number).kind;
            } catch (error) {
                status = classifySafetyError(error) === 'peer-no-keys' ? 'no-keys' : 'error';
            }
            this.statuses.update((all) => ({ ...all, [participant.user_id]: status }));
        }
    }

    openMember(userId: string): void {
        this.safetyRequested.emit(userId);
    }
}
