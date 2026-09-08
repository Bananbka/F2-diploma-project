import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ArrowLeft, Camera, KeyRound, LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { ProfileApiService, ProfileUpdateRequest } from '../../../core/services/profile-api.service';
import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';

@Component({
    selector: 'app-profile',
    imports: [ReactiveFormsModule, LucideAngularModule, AvatarComponent],
    templateUrl: './profile.component.html',
    styleUrl: './profile.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileComponent {
    private readonly profileApi = inject(ProfileApiService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly fb = inject(FormBuilder);

    readonly user = this.session.user;
    readonly saving = signal(false);
    readonly uploading = signal(false);
    readonly saved = signal(false);
    readonly error = signal<string | null>(null);
    readonly avatarUrl = signal<string | null>(this.session.user()?.avatar ?? null);

    readonly form = this.fb.nonNullable.group({
        fullName: [this.session.user()?.full_name ?? '', [Validators.required, Validators.maxLength(30)]],
        username: [
            this.session.user()?.username ?? '',
            [Validators.required, Validators.minLength(6), Validators.pattern(/^[a-zA-Z][a-zA-Z0-9_]*$/)],
        ],
        bio: [this.session.user()?.bio ?? ''],
    });

    readonly arrowLeftIcon = ArrowLeft;
    readonly cameraIcon = Camera;
    readonly keyIcon = KeyRound;

    messageFor(name: keyof typeof this.form.controls): string | null {
        return errorTextFor(this.form.controls[name], {
            required: 'This is required.',
            maxlength: 'Keep this to 30 characters or fewer.',
            minlength: 'Use at least 6 characters.',
            pattern: 'Start with a letter, then letters, digits or underscores only.',
        });
    }

    isInvalid(control: AbstractControl): boolean {
        return control.touched && control.invalid;
    }

    async onAvatarPicked(event: Event): Promise<void> {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) {
            return;
        }

        this.uploading.set(true);
        this.error.set(null);

        try {
            // The avatar bucket is public-read, so the returned URL is directly usable. Attachments
            // are not — that bucket is private and needs the authorised download path.
            const uploaded = await firstValueFrom(this.profileApi.upload(file, 'avatar'));
            this.avatarUrl.set(uploaded.url);
        } catch {
            this.error.set('Could not upload that image.');
        } finally {
            this.uploading.set(false);
        }
    }

    async save(): Promise<void> {
        if (this.form.invalid || this.saving()) {
            this.form.markAllAsTouched();
            return;
        }

        this.saving.set(true);
        this.saved.set(false);
        this.error.set(null);

        const { fullName, username, bio } = this.form.getRawValue();

        // `full_name` always goes; the optional keys are omitted rather than nulled, because an
        // explicit null for `username` fails validation server-side.
        const payload: ProfileUpdateRequest = { full_name: fullName };
        if (username !== this.user()?.username) {
            payload.username = username;
        }
        if (bio) {
            payload.bio = bio;
        }
        if (this.avatarUrl()) {
            payload.avatar_url = this.avatarUrl()!;
        }

        try {
            const updated = await firstValueFrom(this.profileApi.updateProfile(payload));
            // The response omits avatar_url, so keep the locally known value rather than blanking it.
            this.session.user.set({ ...updated, avatar: this.avatarUrl() ?? updated.avatar });
            this.saved.set(true);
        } catch (error) {
            this.error.set(applyServerErrors(this.form, error) ?? 'Could not save your profile.');
        } finally {
            this.saving.set(false);
        }
    }

    async close(): Promise<void> {
        await this.router.navigate(['/chats']);
    }

    async goToPassword(): Promise<void> {
        await this.router.navigate(['/settings/password']);
    }
}
