import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ArrowLeft, Eye, EyeOff, LucideAngularModule, ShieldCheck } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';

type Phase = 'input' | 'rewrapping' | 'done';

@Component({
    selector: 'app-change-password',
    imports: [ReactiveFormsModule, LucideAngularModule],
    templateUrl: './change-password.component.html',
    styleUrl: './change-password.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangePasswordComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    readonly phase = signal<Phase>('input');
    readonly showPassword = signal(false);
    readonly error = signal<string | null>(null);

    readonly form = this.fb.nonNullable.group({
        oldPassword: ['', Validators.required],
        newPassword: ['', [Validators.required, Validators.minLength(12), Validators.maxLength(72)]],
        confirm: ['', Validators.required],
    });

    readonly passwordsMatch = computed(() => this.form.controls.confirm.value === this.form.controls.newPassword.value);

    readonly arrowLeftIcon = ArrowLeft;
    readonly eyeIcon = Eye;
    readonly eyeOffIcon = EyeOff;
    readonly shieldCheckIcon = ShieldCheck;

    messageFor(name: keyof typeof this.form.controls): string | null {
        return errorTextFor(this.form.controls[name], {
            required: 'This is required.',
            minlength: 'Use at least 12 characters.',
            maxlength: 'Keep this to 72 characters or fewer.',
        });
    }

    isInvalid(control: AbstractControl): boolean {
        return control.touched && control.invalid;
    }

    /**
     * Change the password, re-sealing the key bundle in the same request.
     *
     * The visible pause is two Argon2id derivations per device — one to open the bundle under the old
     * password, one to seal it under the new — plus a third to verify the result opens before it is
     * sent. That verification is why this is worth waiting for: the server accepts whatever bundle it
     * is handed without being able to check it, so a silent mis-wrap would lock the account out.
     */
    async submit(): Promise<void> {
        if (this.form.invalid || !this.passwordsMatch() || this.phase() !== 'input') {
            this.form.markAllAsTouched();
            return;
        }

        this.phase.set('rewrapping');
        this.error.set(null);

        const { oldPassword, newPassword } = this.form.getRawValue();

        try {
            await this.session.changePassword(oldPassword, newPassword);
            this.phase.set('done');
        } catch (error) {
            this.phase.set('input');

            if (error instanceof HttpErrorResponse && error.status === 401) {
                this.error.set('That is not your current password.');
                return;
            }

            this.error.set(
                applyServerErrors(this.form, error) ?? 'Could not change the password. Your keys are unchanged.'
            );
        }
    }

    async close(): Promise<void> {
        await this.router.navigate(['/chats']);
    }
}
