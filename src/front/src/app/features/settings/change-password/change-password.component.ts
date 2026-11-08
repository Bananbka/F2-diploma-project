import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Eye, EyeOff, LucideAngularModule, ShieldCheck } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { formSnapshot } from '../../../shared/forms/form-signal';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';
import { SettingsService } from '../settings.service';

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
    private readonly fb = inject(FormBuilder);
    private readonly settings = inject(SettingsService);

    readonly phase = signal<Phase>('input');
    readonly showPassword = signal(false);
    readonly error = signal<string | null>(null);

    readonly form = this.fb.nonNullable.group({
        oldPassword: ['', Validators.required],
        newPassword: ['', [Validators.required, Validators.minLength(12), Validators.maxLength(72)]],
        confirm: ['', Validators.required],
    });

    private readonly snapshot = formSnapshot(this.form);

    readonly passwordsMatch = computed(() => this.snapshot().value.confirm === this.snapshot().value.newPassword);

    readonly eyeIcon = Eye;
    readonly eyeOffIcon = EyeOff;
    readonly shieldCheckIcon = ShieldCheck;

    constructor() {
        // Typed passwords are lost if the dialog closes; a re-seal in flight must not be walked away from.
        const unregister = this.settings.registerDirtyCheck(() => this.phase() === 'rewrapping' || this.form.dirty);
        inject(DestroyRef).onDestroy(unregister);
    }

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

    /** Back to a blank form once the success message has been read. */
    reset(): void {
        this.form.reset();
        this.showPassword.set(false);
        this.error.set(null);
        this.phase.set('input');
    }
}
