import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Eye, EyeOff, LucideAngularModule, ShieldCheck } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, setServerError } from '../../../shared/forms/server-errors';
import { BrandMarkComponent } from '../../../shared/ui/brand-mark/brand-mark.component';

@Component({
    selector: 'app-login',
    imports: [ReactiveFormsModule, RouterLink, LucideAngularModule, BrandMarkComponent],
    templateUrl: './login.component.html',
    styleUrl: './login.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    readonly showPassword = signal(false);
    readonly submitting = signal(false);
    readonly error = signal<string | null>(null);

    readonly form = this.fb.nonNullable.group({
        username: ['', Validators.required],
        password: ['', Validators.required],
    });

    /** Bound from `?reset=1` so the reset flow can explain why the keys are about to be rebuilt. */
    readonly reset = input('');
    readonly justReset = computed(() => this.reset() === '1');

    readonly eyeIcon = Eye;
    readonly eyeOffIcon = EyeOff;
    readonly shieldCheckIcon = ShieldCheck;

    /**
     * Signing in only establishes the session cookie. The private bundle is a separate step, so the
     * next stop is always the unlock screen — the password is deliberately not carried across, since
     * holding it in router state to save one keystroke would put it somewhere it need not be.
     */
    async submit(): Promise<void> {
        if (this.form.invalid || this.submitting()) {
            this.form.markAllAsTouched();
            return;
        }

        this.submitting.set(true);
        this.error.set(null);

        const { username, password } = this.form.getRawValue();

        try {
            await this.session.login(username, password);
            await this.router.navigate(['/unlock']);
        } catch (error) {
            this.handle(error);
        } finally {
            this.submitting.set(false);
        }
    }

    isInvalid(control: AbstractControl): boolean {
        return control.touched && control.invalid;
    }

    serverMessageFor(name: keyof typeof this.form.controls): string | null {
        const server = this.form.controls[name].errors?.['server'];
        return typeof server === 'string' ? server : null;
    }

    /**
     * A rejected sign-in is not attributable to one field — the server deliberately does not say
     * which half was wrong — so both are marked and the explanation goes above the button.
     */
    private handle(error: unknown): void {
        if (error instanceof HttpErrorResponse && (error.status === 401 || error.status === 400)) {
            setServerError(this.form.controls.username, '');
            setServerError(this.form.controls.password, '');
            this.error.set('That username and password do not match.');
            return;
        }

        if (error instanceof HttpErrorResponse && error.status === 403) {
            this.error.set('This account is not verified yet. Check your email for the code.');
            return;
        }

        this.error.set(applyServerErrors(this.form, error) ?? 'Could not sign in. Please try again.');
    }
}
