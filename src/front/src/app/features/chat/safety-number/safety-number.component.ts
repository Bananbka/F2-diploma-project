import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ArrowLeft, Check, Copy, Info, LucideAngularModule, ShieldAlert, ShieldCheck } from 'lucide-angular';
import * as QRCode from 'qrcode';
import { firstValueFrom } from 'rxjs';

import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { safetyNumberGroups } from '../../../shared/utils/display';

@Component({
    selector: 'app-safety-number',
    imports: [LucideAngularModule],
    templateUrl: './safety-number.component.html',
    styleUrl: './safety-number.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SafetyNumberComponent {
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly directory = inject(DirectoryService);
    private readonly trust = inject(TrustStoreService);
    private readonly router = inject(Router);

    readonly chatId = input.required<string>();
    readonly userId = input.required<string>();

    readonly safetyNumber = signal<string | null>(null);
    readonly qrDataUrl = signal<string | null>(null);
    readonly loading = signal(true);
    readonly error = signal<string | null>(null);
    readonly copied = signal(false);
    /** Bumped on every trust write so the derived state recomputes. */
    private readonly trustEpoch = signal(0);

    readonly peer = computed(() => this.directory.lookup(this.userId()));
    readonly groups = computed(() => safetyNumberGroups(this.safetyNumber() ?? ''));

    readonly state = computed(() => {
        const number = this.safetyNumber();
        this.trustEpoch();
        return number ? this.trust.stateFor(this.userId(), number) : null;
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
        this.qrDataUrl.set(null);

        try {
            const number = await firstValueFrom(this.cryptoApi.getSafetyNumber(userId));
            this.safetyNumber.set(number);
            await this.renderQr(number);
        } catch {
            this.error.set('Could not compute a safety number for this contact.');
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
        if (!number) {
            return;
        }
        this.trust.markVerified(this.userId(), number);
        this.trustEpoch.update((n) => n + 1);
    }

    /** Accept the new key after re-comparing. Deliberately a separate, explicit action. */
    acceptChange(): void {
        this.markVerified();
    }

    reset(): void {
        this.trust.forget(this.userId());
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
