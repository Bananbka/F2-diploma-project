import { HttpErrorResponse } from '@angular/common/http';
import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    ElementRef,
    inject,
    input,
    signal,
    viewChildren,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ArrowLeft, LucideAngularModule, Shield } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';

const CODE_LENGTH = 6;
const RESEND_SECONDS = 59;

@Component({
    selector: 'app-verify-email',
    imports: [RouterLink, LucideAngularModule],
    templateUrl: './verify-email.component.html',
    styleUrl: './verify-email.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerifyEmailComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly destroyRef = inject(DestroyRef);

    /** Bound from `?email=` by `withComponentInputBinding`. */
    readonly email = input('');

    readonly digits = signal<string[]>(Array(CODE_LENGTH).fill(''));
    readonly countdown = signal(RESEND_SECONDS);
    readonly submitting = signal(false);
    readonly resending = signal(false);
    readonly error = signal<string | null>(null);

    readonly code = computed(() => this.digits().join(''));
    readonly isComplete = computed(() => this.code().length === CODE_LENGTH);
    readonly countdownLabel = computed(() => `0:${String(this.countdown()).padStart(2, '0')}`);

    private readonly boxes = viewChildren<ElementRef<HTMLInputElement>>('box');

    readonly arrowLeftIcon = ArrowLeft;
    readonly shieldIcon = Shield;

    constructor() {
        const timer = setInterval(() => this.countdown.update((c) => Math.max(0, c - 1)), 1000);
        this.destroyRef.onDestroy(() => clearInterval(timer));
    }

    /**
     * Accepts a pasted code as well as single keystrokes — mail clients hand over all six digits at
     * once, and forcing the user to retype them is pure friction.
     */
    onInput(index: number, event: Event): void {
        const input_ = event.target as HTMLInputElement;
        const entered = input_.value.replace(/\D/g, '');

        this.digits.update((current) => {
            const next = [...current];
            if (entered.length > 1) {
                for (let i = 0; i < entered.length && index + i < CODE_LENGTH; i++) {
                    next[index + i] = entered[i];
                }
            } else {
                next[index] = entered.slice(-1);
            }
            return next;
        });

        // Re-sync the DOM: the signal is the source of truth, and a paste wrote six characters into
        // one box.
        this.paint();
        this.focusBox(entered.length > 1 ? this.digits().filter(Boolean).length : index + (entered ? 1 : 0));

        if (this.isComplete()) {
            void this.submit();
        }
    }

    onKeydown(index: number, event: KeyboardEvent): void {
        if (event.key !== 'Backspace' || this.digits()[index]) {
            return;
        }

        event.preventDefault();
        this.digits.update((current) => {
            const next = [...current];
            next[Math.max(0, index - 1)] = '';
            return next;
        });
        this.paint();
        this.focusBox(index - 1);
    }

    private paint(): void {
        const digits = this.digits();
        this.boxes().forEach((box, i) => (box.nativeElement.value = digits[i] ?? ''));
    }

    private focusBox(index: number): void {
        this.boxes()[Math.max(0, Math.min(index, CODE_LENGTH - 1))]?.nativeElement.focus();
    }

    async submit(): Promise<void> {
        if (!this.isComplete() || this.submitting()) {
            return;
        }

        this.submitting.set(true);
        this.error.set(null);

        try {
            await this.session.verifyEmail(this.email(), this.code());
            // Registration already set the token cookies, so the account is signed in the moment it
            // is verified. All that is left is opening the key store.
            await this.router.navigate(['/unlock']);
        } catch (error) {
            this.error.set(
                error instanceof HttpErrorResponse && (error.status === 400 || error.status === 404)
                    ? 'That code is not valid or has expired.'
                    : 'Could not verify the code. Please try again.'
            );
            this.digits.set(Array(CODE_LENGTH).fill(''));
            this.paint();
            this.focusBox(0);
        } finally {
            this.submitting.set(false);
        }
    }

    async resend(): Promise<void> {
        if (this.resending()) {
            return;
        }

        this.resending.set(true);
        this.error.set(null);

        try {
            await this.session.resendVerificationEmail();
            this.countdown.set(RESEND_SECONDS);
        } catch {
            this.error.set('Could not send a new code. Try again in a moment.');
        } finally {
            this.resending.set(false);
        }
    }
}
