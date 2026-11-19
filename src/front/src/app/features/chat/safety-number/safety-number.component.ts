import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ArrowLeft, Check, Copy, Info, LucideAngularModule, ShieldAlert, ShieldCheck } from 'lucide-angular';
import * as QRCode from 'qrcode';

import { DirectoryService } from '../../../core/services/directory.service';
import { KeyChangeStateService } from '../../../core/services/key-change-state.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { safetyDigits } from '../../../core/services/trust-keys';
import { TrustState, TrustStoreService } from '../../../core/services/trust-store.service';
import { safetyNumberGroups } from '../../../shared/utils/display';
import { SettingsService } from '../../settings/settings.service';

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
    private readonly keyChange = inject(KeyChangeStateService);
    private readonly settings = inject(SettingsService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);

    readonly chatId = input.required<string>();
    readonly userId = input.required<string>();
    /** Shown inside the chat-info side panel, which supplies its own header and back control. */
    readonly embedded = input(false);

    /** What `computeSafetyNumber` derived from a batch key lookup for this pair. */
    private readonly lookedUp = signal<string | null>(null);

    /**
     * The number the send path is currently blocked on for this pair (a roster-derived observation,
     * or the one a `KeyChangedError` carried), if any. Reactive: it lapses once that number is
     * accepted, and appears if a refusal happens while this screen is open.
     */
    private readonly blocking = computed(() => {
        const selfId = this.selfId();
        // Scoped to this screen's chat: the number *this* chat was refused on, which another chat's
        // honest roster for the same person cannot replace.
        return selfId ? this.keyChange.blockingNumber(selfId, this.userId(), this.chatId()) : null;
    });

    /**
     * The number that would be compared right now. The blocking one wins over the lookup: accepting
     * a number is only meaningful if it is the one the send path checks, and a server that
     * equivocates can answer the lookup with the old keys while the roster carries new ones — which
     * would show "verified, unchanged" here while every send stays refused.
     */
    private readonly liveNumber = computed(() => this.blocking() ?? this.lookedUp());

    /**
     * The number on screen — a snapshot of `liveNumber` taken when it was shown, so digits never
     * change under a user who is reading them out. Accepting always records exactly these digits.
     */
    private readonly shown = signal<string | null>(null);
    readonly safetyNumber = this.shown.asReadonly();

    /**
     * The live number moved away from the digits on screen (a refusal or a new lookup arrived while
     * this was open). Accepting is disabled until the user reloads the comparison: confirming digits
     * that are no longer the ones in force would record the wrong number.
     */
    readonly numberChanged = computed(() => {
        const shown = this.shown();
        const live = this.liveNumber();
        return !!shown && !!live && safetyDigits(shown) !== safetyDigits(live);
    });

    /**
     * The lookup and the send path's roster derive different numbers for the same pair. Either the
     * keys changed between the two requests, or the server is presenting different keys to each.
     */
    readonly lookupDisagrees = computed(() => {
        const blocking = this.blocking();
        const lookedUp = this.lookedUp();
        return !!blocking && !!lookedUp && safetyDigits(blocking) !== safetyDigits(lookedUp);
    });

    /** Our own side of the number covers a device no device list of ours contains. */
    readonly ownDevicesUnknown = signal(false);

    /** Our side covers a device our device list at unlock lacks, and a fresh list could not be fetched. */
    readonly ownDevicesUnchecked = signal(false);

    /** Our side covers a device our account gained since unlock. A notice, not an alarm (N). */
    readonly ownDevicesAdded = signal(false);

    /** The last verification change could not be saved: it lasts only as long as this tab. */
    readonly saveFailed = signal(false);

    /**
     * "Clear verification" was refused: a send is refused on a changed number for this person, and
     * clearing would let the refused keys through on trust-on-first-use. Accepting a number is the
     * way out.
     */
    readonly forgetRefused = signal(false);

    readonly qrDataUrl = signal<string | null>(null);
    /** The number the current QR encodes, so a superseded render cannot overwrite a newer one. */
    private qrFor: string | null = null;
    readonly loading = signal(true);
    readonly error = signal<string | null>(null);
    readonly failure = signal<SafetyFailure | null>(null);
    readonly copied = signal(false);
    /** Whose number this is: trust records are per pair, so both ids are needed. */
    private readonly selfId = computed(() => this.session.user()?.id ?? null);

    readonly peer = computed(() => this.directory.lookup(this.userId()));
    readonly groups = computed(() => safetyNumberGroups(this.safetyNumber() ?? ''));

    /**
     * The trust state of the digits on screen — except that while this chat holds a refusal for
     * this person it is always `changed`. Otherwise digits that happen to equal the old record read
     * as "verified, unchanged" with a "Clear verification" button, while sending stays refused.
     */
    readonly state = computed<TrustState | null>(() => {
        const number = this.safetyNumber();
        const selfId = this.selfId();
        if (!number || !selfId) {
            return null;
        }
        const base = this.trust.stateFor(selfId, this.userId(), number);
        const refusal = this.keyChange.refusalFor(this.chatId(), selfId, this.userId());
        if (refusal && base.kind !== 'changed') {
            return {
                kind: 'changed',
                previous: refusal.previous,
                verifiedAt: base.kind === 'verified' ? base.verifiedAt : '',
            };
        }
        return base;
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

    /** Bumped per `load`; an await that returns to an older generation drops its result (H). */
    private loadGen = 0;

    private async load(userId: string): Promise<void> {
        const gen = ++this.loadGen;
        const stale = (): boolean => gen !== this.loadGen;
        this.loading.set(true);
        this.error.set(null);
        this.failure.set(null);
        this.qrDataUrl.set(null);
        this.qrFor = null;
        this.lookedUp.set(null);
        this.shown.set(null);
        this.ownDevicesUnknown.set(false);
        this.ownDevicesUnchecked.set(false);
        this.ownDevicesAdded.set(false);
        this.saveFailed.set(false);
        this.forgetRefused.set(false);

        try {
            // Derived here, not fetched. The server endpoint still exists as a convenience, but
            // a fingerprint the server hands you cannot detect a key the server substituted.
            const result = await this.keyStore.computeSafetyNumber(userId);
            if (stale()) {
                // The user switched to someone else while this was computing.
                return;
            }
            this.lookedUp.set(result.number);
            this.ownDevicesUnknown.set(result.ownDevicesUnknown);
            this.ownDevicesUnchecked.set(result.ownDevicesUnchecked);
            this.ownDevicesAdded.set(result.ownDevicesAdded);
            await this.reloadComparison();
        } catch (error) {
            if (stale()) {
                return;
            }
            if (this.blocking()) {
                // The lookup failed, but the number sending is blocked on is known and is the one
                // that matters here; show it rather than an error with no way forward.
                await this.reloadComparison();
                return;
            }
            const failure = classifySafetyError(error);
            this.failure.set(failure);
            this.error.set(
                failure === 'peer-no-keys'
                    ? `${this.peer().name} has not published encryption keys yet, so there is no safety number.`
                    : failure === 'self-no-keys'
                      ? 'You have not published encryption keys yet, so there is no safety number to compare.'
                      : 'Could not compute a safety number for this contact.'
            );
        } finally {
            if (!stale()) {
                this.loading.set(false);
            }
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
        this.qrFor = number;
        try {
            const url = await QRCode.toDataURL(number.replace(/\s+/g, ''), {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 320,
                color: { dark: '#0a0a0cff', light: '#ffffffff' },
            });
            // Superseded while rendering: the newer render owns the image.
            if (this.qrFor === number) {
                this.qrDataUrl.set(url);
            }
        } catch {
            // The digits below are the authoritative comparison; the QR is a convenience.
            if (this.qrFor === number) {
                this.qrDataUrl.set(null);
            }
        }
    }

    /** Show the number currently in force, replacing the snapshot on screen. */
    async reloadComparison(): Promise<void> {
        const live = this.liveNumber();
        this.shown.set(live);
        if (live) {
            await this.renderQr(live);
        } else {
            this.qrDataUrl.set(null);
        }
    }

    /** Devices live on the Security tab of the settings dialog. */
    reviewDevices(): void {
        this.settings.open('security');
    }

    markVerified(): void {
        const number = this.shown();
        const selfId = this.selfId();
        if (!number || !selfId || this.numberChanged()) {
            return;
        }
        this.saveFailed.set(this.trust.markVerified(selfId, this.userId(), number) === 'unsaved');
        this.forgetRefused.set(false);
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
        const result = this.trust.forget(selfId, this.userId());
        this.saveFailed.set(result === 'unsaved');
        this.forgetRefused.set(result === 'refused');
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
