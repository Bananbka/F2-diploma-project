import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ArrowLeft, Check, Copy, Info, LucideAngularModule, ShieldAlert, ShieldCheck } from 'lucide-angular';
import * as QRCode from 'qrcode';

import { DirectoryService } from '../../../core/services/directory.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { safetyNumberGroups } from '../../../shared/utils/display';

/** Why a safety number could not be produced, so each case can say what is actually wrong. */
export type SafetyFailure = 'peer-no-keys' | 'self-no-keys' | 'failed';

export function classifySafetyError(error: unknown): SafetyFailure {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('This contact has not published')) {
        return 'peer-no-keys';
    }
    if (message.includes('You have not published')) {
        return 'self-no-keys';
    }
    return 'failed';
}

@Component({
    selector: 'app-safety-number',
    imports: [LucideAngularModule],
    templateUrl: './safety-number.component.html',
    styleUrl: './safety-number.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '[class.is-embedded]': 'embedded()' },
})
export class SafetyNumberComponent {
    private readonly keyStore = inject(KeyStoreService);
    private readonly directory = inject(DirectoryService);
    private readonly trust = inject(TrustStoreService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);

    readonly chatId = input.required<string>();
    readonly userId = input.required<string>();
    /** Shown inside the chat-info side panel, which supplies its own header and back control. */
    readonly embedded = input(false);

    readonly safetyNumber = signal<string | null>(null);
    readonly qrDataUrl = signal<string | null>(null);
    readonly loading = signal(true);
    readonly error = signal<string | null>(null);
    readonly failure = signal<SafetyFailure | null>(null);
    readonly copied = signal(false);
    /** Bumped on every trust write so the derived state recomputes. */
    private readonly trustEpoch = signal(0);

    /** Whose number this is: trust records are per pair, so both ids are needed. */
    private readonly selfId = computed(() => this.session.user()?.id ?? null);

    readonly peer = computed(() => this.directory.lookup(this.userId()));
    readonly groups = computed(() => safetyNumberGroups(this.safetyNumber() ?? ''));

    readonly state = computed(() => {
        const number = this.safetyNumber();
        this.trustEpoch();
        const selfId = this.selfId();
        return number && selfId ? this.trust.stateFor(selfId, this.userId(), number) : null;
    });

    readonly arrowLeftIcon = ArrowLeft;
    readonly infoIcon = Info;
    readonly checkIcon = Check;
    readonly copyIcon = Copy;
    readonly shieldCheckIcon = ShieldCheck;
    readonly shieldAlertIcon = ShieldAlert;

    constructor() {
        effect(() => void this.load(this.userId()));
    }

    private async load(userId: string): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        this.failure.set(null);
        this.qrDataUrl.set(null);

        try {
            // Derived here, not fetched. The server endpoint still exists as a convenience, but
            // a fingerprint the server hands you cannot detect a key the server substituted.
            const number = await this.keyStore.computeSafetyNumber(userId);
            this.safetyNumber.set(number);
            await this.renderQr(number);
        } catch (error) {
            const failure = classifySafetyError(error);
            this.failure.set(failure);
            this.error.set(
                failure === 'peer-no-keys'
                    ? `${this.peer().name} has not published encryption keys yet, so there is no safety number.`
                    : failure === 'self-no-keys'
                      ? 'You have not published encryption keys yet, so there is no safety number to compare.'
                      : 'Could not compute a safety number for this contact.'
            );
            this.safetyNumber.set(null);
        } finally {
            this.loading.set(false);
        }
    }

    /**
     * A real QR of the actual fingerprint digits.
     *
     * Not a decorative one: a placeholder pattern on this screen would imply that scanning compares
     * something, and two users scanning meaningless codes would believe they had verified a
     * conversation they had not.
     */
    private async renderQr(number: string): Promise<void> {
        try {
            this.qrDataUrl.set(
                await QRCode.toDataURL(number.replace(/\s+/g, ''), {
                    errorCorrectionLevel: 'M',
                    margin: 2,
                    width: 320,
                    color: { dark: '#0a0a0cff', light: '#ffffffff' },
                })
            );
        } catch {
            // The digits below are the authoritative comparison; the QR is a convenience.
            this.qrDataUrl.set(null);
        }
    }

    markVerified(): void {
        const number = this.safetyNumber();
        const selfId = this.selfId();
        if (!number || !selfId) {
            return;
        }
        this.trust.markVerified(selfId, this.userId(), number);
        this.trustEpoch.update((n) => n + 1);
    }

    /** Accept the new key after re-comparing. Deliberately a separate, explicit action. */
    acceptChange(): void {
        this.markVerified();
    }

    reset(): void {
        const selfId = this.selfId();
        if (!selfId) {
            return;
        }
        this.trust.forget(selfId, this.userId());
        this.trustEpoch.update((n) => n + 1);
    }

    async copy(): Promise<void> {
        const number = this.safetyNumber();
        if (!number) {
            return;
        }

        try {
            await navigator.clipboard.writeText(number);
            this.copied.set(true);
            setTimeout(() => this.copied.set(false), 1500);
        } catch {
            // Clipboard permission denied — the digits are on screen to read aloud regardless.
        }
    }

    async back(): Promise<void> {
        await this.router.navigate(['/chats', this.chatId()]);
    }
}
