import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Camera, LucideAngularModule, Trash2 } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { ProfileApiService, ProfileUpdateRequest } from '../../../core/services/profile-api.service';
import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { AvatarCropperComponent } from '../../../shared/ui/avatar-cropper/avatar-cropper.component';
import { EmojiButtonComponent } from '../../../shared/ui/emoji-field/emoji-button.component';
import { SettingsService } from '../settings.service';

/**
 * The Profile tab: name, username, bio and avatar, plus the account's email and phone (read-only —
 * there is no endpoint to change either).
 *
 * Picking a photo opens the cropper rather than uploading straight away, so the user decides how it
 * sits inside the round avatar. The cropped result goes through the same upload path as before, and
 * like before it only becomes the avatar once the profile is saved.
 */
@Component({
    selector: 'app-profile',
    imports: [ReactiveFormsModule, LucideAngularModule, AvatarComponent, AvatarCropperComponent, EmojiButtonComponent],
    templateUrl: './profile.component.html',
    styleUrl: './profile.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileComponent {
    private readonly profileApi = inject(ProfileApiService);
    private readonly session = inject(SessionService);
    private readonly settings = inject(SettingsService);
    private readonly fb = inject(FormBuilder);

    readonly user = this.session.user;
    readonly saving = signal(false);
    readonly uploading = signal(false);
    readonly saved = signal(false);
    readonly error = signal<string | null>(null);
    readonly avatarUrl = signal<string | null>(this.session.user()?.avatar_url ?? null);
    /** The picked file awaiting the cropper; null whenever the cropper is closed. */
    readonly cropFile = signal<File | null>(null);

    readonly form = this.fb.nonNullable.group({
        fullName: [this.session.user()?.full_name ?? '', [Validators.required, Validators.maxLength(30)]],
        username: [
            this.session.user()?.username ?? '',
            [Validators.required, Validators.minLength(6), Validators.pattern(/^[a-zA-Z][a-zA-Z0-9_]*$/)],
        ],
        bio: [this.session.user()?.bio ?? ''],
    });

    readonly cameraIcon = Camera;
    readonly trashIcon = Trash2;

    /** A cropped photo whose upload failed, kept so retrying does not mean cropping it again. */
    readonly failedUpload = signal<File | null>(null);

    constructor() {
        // Closing the dialog or switching tab asks first when this returns true.
        const unregister = this.settings.registerDirtyCheck(() => this.hasUnsavedChanges());
        inject(DestroyRef).onDestroy(unregister);
    }

    hasUnsavedChanges(): boolean {
        return this.form.dirty || this.avatarUrl() !== (this.session.user()?.avatar_url ?? null);
    }

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

    onAvatarPicked(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        // Clear it so choosing the same file again after a cancel still fires `change`.
        input.value = '';
        if (!file) {
            return;
        }
        this.error.set(null);
        this.cropFile.set(file);
    }

    cancelCrop(): void {
        this.cropFile.set(null);
    }

    async onCropApplied(file: File): Promise<void> {
        this.cropFile.set(null);
        await this.upload(file);
    }

    async retryUpload(): Promise<void> {
        const file = this.failedUpload();
        if (file) {
            await this.upload(file);
        }
    }

    private async upload(file: File): Promise<void> {
        this.uploading.set(true);
        this.error.set(null);
        this.failedUpload.set(null);

        try {
            // The avatar bucket is public-read, so the returned URL is directly usable. Attachments
            // are not — that bucket is private and needs the authorised download path.
            const uploaded = await firstValueFrom(this.profileApi.upload(file, 'avatar'));
            this.avatarUrl.set(uploaded.url);
        } catch {
            this.failedUpload.set(file);
            this.error.set('Could not upload that image.');
        } finally {
            this.uploading.set(false);
        }
    }

    /** Takes effect on Save (`avatar_url: null` clears it server-side), like a new photo does. */
    removeAvatar(): void {
        this.failedUpload.set(null);
        this.error.set(null);
        this.avatarUrl.set(null);
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
        // An emptied bio is sent as null, which clears it; omitting the key would leave the old one.
        if (bio !== (this.user()?.bio ?? '')) {
            payload.bio = bio.trim() ? bio : null;
        }
        if (this.avatarUrl() !== (this.user()?.avatar_url ?? null)) {
            payload.avatar_url = this.avatarUrl();
        }

        try {
            const updated = await firstValueFrom(this.profileApi.updateProfile(payload));
            // The response omits avatar_url, so keep the locally known value rather than blanking it.
            this.session.user.set({ ...updated, avatar_url: this.avatarUrl() });
            this.form.markAsPristine();
            this.saved.set(true);
        } catch (error) {
            this.error.set(applyServerErrors(this.form, error) ?? 'Could not save your profile.');
        } finally {
            this.saving.set(false);
        }
    }
}
