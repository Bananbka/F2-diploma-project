import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ArrowLeft, Eye, EyeOff, LucideAngularModule, ShieldAlert } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';

/**
 * What the user must type to proceed.
 *
 * A checkbox is too cheap for this. Resetting discards the only key that can open the account's
 * history, and no support process can undo it — so the confirmation is deliberately something you
 * cannot click through by reflex.
 */
const ACKNOWLEDGEMENT = 'DELETE MY HISTORY';

@Component({
    selector: 'app-reset-password',
    imports: [ReactiveFormsModule, RouterLink, LucideAngularModule],
    templateUrl: './reset-password.component.html',
    styleUrl: './reset-password.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPasswordComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    /** Carried from the forgot-password screen so the user does not retype it. */
    readonly username = input('');

    readonly showPassword = signal(false);
    readonly submitting = signal(false);
    readonly error = signal<string | null>(null);

    readonly acknowledgement = ACKNOWLEDGEMENT;

    readonly form = this.fb.nonNullable.group({
        otp: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
        newPassword: ['', [Validators.required, Validators.minLength(12), Validators.maxLength(72)]],
        confirm: ['', Validators.required],
    });

    readonly acknowledged = signal('');

    readonly passwordsMatch = computed(() => this.form.controls.confirm.value === this.form.controls.newPassword.value);

    readonly canSubmit = computed(
        () => this.acknowledged().trim().toUpperCase() === ACKNOWLEDGEMENT && !this.submitting()
    );

    readonly arrowLeftIcon = ArrowLeft;
    readonly eyeIcon = Eye;
    readonly eyeOffIcon = EyeOff;
    readonly shieldAlertIcon = ShieldAlert;

    messageFor(name: keyof typeof this.form.controls): string | null {
        return errorTextFor(this.form.controls[name], {
            required: 'This is required.',
            pattern: 'The code is six digits.',
            minlength: 'Use at least 12 characters.',
            maxlength: 'Keep this to 72 characters or fewer.',
        });
    }

    isInvalid(control: AbstractControl): boolean {
        return control.touched && control.invalid;
    }

    /**
     * Reset, then send the user to sign in again.
     *
     * The server revokes every device and issues no new cookies, so there is no session to continue
     * into. On the next sign-in the account has no identity and `unlock` provisions a fresh one.
     */
    async submit(): Promise<void> {
        if (this.form.invalid || !this.canSubmit() || !this.passwordsMatch()) {
            this.form.markAllAsTouched();
            return;
        }

        this.submitting.set(true);
        this.error.set(null);

        const { otp, newPassword } = this.form.getRawValue();

        try {
            await this.session.resetPassword(this.username(), otp, newPassword);
            await this.router.navigate(['/login'], { queryParams: { reset: '1' } });
        } catch (error) {
            this.error.set(
                error instanceof HttpErrorResponse && error.status === 404
                    ? 'That code is not valid or has expired. Request a new one.'
                    : (applyServerErrors(this.form, error) ?? 'Could not reset the password. Please try again.')
            );
        } finally {
            this.submitting.set(false);
        }
    }
}
