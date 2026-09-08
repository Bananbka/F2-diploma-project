import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ArrowLeft, KeyRound, LucideAngularModule, ShieldAlert } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';

@Component({
    selector: 'app-forgot-password',
    imports: [ReactiveFormsModule, RouterLink, LucideAngularModule],
    templateUrl: './forgot-password.component.html',
    styleUrl: './forgot-password.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPasswordComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    readonly submitting = signal(false);
    readonly error = signal<string | null>(null);

    /** The account is matched on both together, so neither field is optional. */
    readonly form = this.fb.nonNullable.group({
        username: ['', Validators.required],
        email: ['', [Validators.required, Validators.email]],
    });

    readonly arrowLeftIcon = ArrowLeft;
    readonly keyIcon = KeyRound;
    readonly shieldAlertIcon = ShieldAlert;

    messageFor(name: keyof typeof this.form.controls): string | null {
        return errorTextFor(this.form.controls[name], {
            required: 'This is required.',
            email: 'That does not look like an email address.',
        });
    }

    isInvalid(control: AbstractControl): boolean {
        return control.touched && control.invalid;
    }

    async submit(): Promise<void> {
        if (this.form.invalid || this.submitting()) {
            this.form.markAllAsTouched();
            return;
        }

        this.submitting.set(true);
        this.error.set(null);

        const { username, email } = this.form.getRawValue();

        try {
            await this.session.forgotPassword(username, email);
            await this.router.navigate(['/reset-password'], { queryParams: { username } });
        } catch (error) {
            this.error.set(
                error instanceof HttpErrorResponse && error.status === 404
                    ? 'No account matches that username and email.'
                    : (applyServerErrors(this.form, error) ?? 'Could not send a reset code. Please try again.')
            );
        } finally {
            this.submitting.set(false);
        }
    }
}
