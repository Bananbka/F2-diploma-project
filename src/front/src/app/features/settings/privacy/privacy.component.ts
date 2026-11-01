import { HttpErrorResponse } from '@angular/common/http';
import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    inject,
    Injector,
    signal,
    viewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AlertTriangle, LucideAngularModule, UserX } from 'lucide-angular';

import { SessionService } from '../../../core/services/session.service';
import { SettingsService } from '../settings.service';

/**
 * The Privacy & data tab: what is and is not private, and the danger zone.
 *
 * Only what exists lives here. There is no switch for read receipts, last-seen or message retention
 * because the server has none, so the tab says what is true instead of offering a control that
 * could not work.
 */
@Component({
    selector: 'app-privacy',
    imports: [ReactiveFormsModule, LucideAngularModule],
    templateUrl: './privacy.component.html',
    styleUrl: './privacy.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly settings = inject(SettingsService);
    private readonly injector = inject(Injector);

    private readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('passwordInput');
    private readonly deleteTrigger = viewChild<ElementRef<HTMLButtonElement>>('deleteTrigger');

    readonly deleteOpen = signal(false);
    readonly deleting = signal(false);
    readonly deleteError = signal<string | null>(null);
    readonly deletePassword = new FormControl('', { nonNullable: true, validators: [Validators.required] });

    readonly deleteIcon = UserX;
    readonly warnIcon = AlertTriangle;

    openDelete(): void {
        this.deletePassword.reset('');
        this.deleteError.set(null);
        this.deleteOpen.set(true);
        afterNextRender(() => this.passwordInput()?.nativeElement.focus(), { injector: this.injector });
    }

    closeDelete(): void {
        // Not dismissible mid-request: the account may already be gone by the time it answers.
        if (this.deleting()) {
            return;
        }
        this.deletePassword.reset('');
        this.deleteOpen.set(false);
        afterNextRender(() => this.deleteTrigger()?.nativeElement.focus(), { injector: this.injector });
    }

    onDialogKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            // Close this dialog only; the settings dialog around it stays open.
            event.preventDefault();
            event.stopPropagation();
            this.closeDelete();
        }
    }

    /**
     * Delete the account for good.
     *
     * Irreversible, so the dialog states the consequences first and the server demands the password
     * again. On success the session has already torn down local state; all that is left is to leave
     * the app. Any failure keeps the dialog open with the account untouched.
     */
    async confirmDelete(): Promise<void> {
        if (this.deletePassword.invalid || this.deleting()) {
            this.deletePassword.markAsTouched();
            return;
        }

        this.deleting.set(true);
        this.deleteError.set(null);

        try {
            await this.session.deleteAccount(this.deletePassword.value);
        } catch (error) {
            this.deleting.set(false);
            this.deleteError.set(this.deleteErrorText(error));
            return;
        }

        this.deleting.set(false);
        this.deleteOpen.set(false);
        this.settings.close();
        await this.router.navigate(['/login']);
    }

    private deleteErrorText(error: unknown): string {
        if (error instanceof HttpErrorResponse) {
            if (error.status === 401) {
                return 'That is not your password. Your account has not been deleted.';
            }
            if (error.status === 429) {
                return 'Too many attempts. Wait a few minutes and try again. Your account has not been deleted.';
            }
        }
        return 'Could not delete your account. Nothing was changed — please try again.';
    }
}
