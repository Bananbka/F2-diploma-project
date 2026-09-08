import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Eye, EyeOff, LucideAngularModule, ShieldCheck } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';
import { BrandMarkComponent } from '../../../shared/ui/brand-mark/brand-mark.component';

/** Local validation messages, keyed by the validator that failed. */
const MESSAGES: Record<string, Partial<Record<string, string>>> = {
    fullName: {
        required: 'Enter your name.',
        maxlength: 'Keep this to 30 characters or fewer.',
    },
    username: {
        required: 'Choose a username.',
        minlength: 'Use at least 6 characters.',
        pattern: 'Start with a letter, then letters, digits or underscores only.',
    },
    email: {
        required: 'Enter your email address.',
        email: 'That does not look like an email address.',
    },
    phoneNumber: {
        required: 'Enter your phone number.',
        pattern: 'Start with + and the country code, e.g. +380501234567.',
    },
    password: {
        required: 'Choose a password.',
        minlength: 'Use at least 12 characters.',
        maxlength: 'Keep this to 72 characters or fewer.',
    },
};

@Component({
    selector: 'app-register',
    imports: [ReactiveFormsModule, RouterLink, LucideAngularModule, BrandMarkComponent],
    templateUrl: './register.component.html',
    styleUrl: './register.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    readonly showPassword = signal(false);
    readonly submitting = signal(false);
    readonly error = signal<string | null>(null);

    /**
     * Full name and phone number are not in the design, but `POST /auth/register` requires both —
     * the phone number is parsed by libphonenumber server-side, so it cannot be defaulted.
     *
     * The pattern here only checks the shape. Whether a number actually exists in its country is a
     * question the client cannot answer, so that verdict comes back from the server and is attached
     * to this control by `applyServerErrors`.
     */
    readonly form = this.fb.nonNullable.group({
        fullName: ['', [Validators.required, Validators.maxLength(30)]],
        username: ['', [Validators.required, Validators.minLength(6), Validators.pattern(/^[a-zA-Z][a-zA-Z0-9_]*$/)]],
        email: ['', [Validators.required, Validators.email]],
        phoneNumber: ['', [Validators.required, Validators.pattern(/^\+[1-9]\d{7,14}$/)]],
        password: ['', [Validators.required, Validators.minLength(12), Validators.maxLength(72)]],
    });

    readonly eyeIcon = Eye;
    readonly eyeOffIcon = EyeOff;
    readonly shieldCheckIcon = ShieldCheck;

    /** The message under a field, whether it came from a local validator or from the server. */
    messageFor(name: keyof typeof this.form.controls): string | null {
        return errorTextFor(this.form.controls[name], MESSAGES[name] ?? {});
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

        const { email } = this.form.getRawValue();

        try {
            await this.session.register(this.form.getRawValue());
            // The OTP is mailed to this address, so the verify screen needs it to label itself.
            await this.router.navigate(['/verify'], { queryParams: { email } });
        } catch (error) {
            // Field-level rejections land on their fields; only what is left over shows up here.
            this.error.set(applyServerErrors(this.form, error) ?? 'Could not create the account. Please try again.');
        } finally {
            this.submitting.set(false);
        }
    }
}
