import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ArrowLeft, Camera, KeyRound, LucideAngularModule, RefreshCw } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { ProfileApiService, ProfileUpdateRequest } from '../../../core/services/profile-api.service';
import { SessionService } from '../../../core/services/session.service';
import { applyServerErrors, errorTextFor } from '../../../shared/forms/server-errors';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';

/** One published device, plus whether it is the one being used right now. */
interface DeviceRow {
    device_id: string;
    display_name: string;
    version: number;
    created_at: string;
    isThis: boolean;
    /** Owner-only field; used to show when this device's signed prekey was last rotated. */
    signed_prekey_created_at: string | null;
}

@Component({
    selector: 'app-profile',
    imports: [ReactiveFormsModule, LucideAngularModule, AvatarComponent, DatePipe],
    templateUrl: './profile.component.html',
    styleUrl: './profile.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileComponent {
    private readonly profileApi = inject(ProfileApiService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly keyStore = inject(KeyStoreService);

    constructor() {
        void this.loadDevices();
    }
    private readonly fb = inject(FormBuilder);

    readonly user = this.session.user;
    readonly saving = signal(false);
    readonly uploading = signal(false);
    readonly saved = signal(false);
    readonly error = signal<string | null>(null);
    readonly avatarUrl = signal<string | null>(this.session.user()?.avatar ?? null);

    readonly devices = signal<DeviceRow[]>([]);
    readonly devicesLoading = signal(true);
    readonly revoking = signal(false);
    readonly deviceError = signal<string | null>(null);
    /** The device id whose revoke button is armed, if any. */
    readonly confirmingDevice = signal<string | null>(null);

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
    readonly rotateIcon = RefreshCw;

    readonly rotatingPrekey = signal(false);
    readonly prekeyRotated = signal(false);
    readonly prekeyError = signal<string | null>(null);

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

    private async loadDevices(): Promise<void> {
        this.devicesLoading.set(true);
        try {
            const identities = await firstValueFrom(this.cryptoApi.getOwnIdentities());
            const thisDevice = this.keyStore.deviceId;

            this.devices.set(
                identities.map((identity) => ({
                    device_id: identity.device_id,
                    display_name: identity.display_name ?? '',
                    version: identity.version,
                    created_at: identity.created_at,
                    isThis: identity.device_id === thisDevice,
                    signed_prekey_created_at: identity.signed_prekey_created_at,
                }))
            );
        } catch {
            this.deviceError.set('Could not load your devices.');
        } finally {
            this.devicesLoading.set(false);
        }
    }

    /**
     * Revoke a device this account no longer controls, two-step.
     *
     * Every encrypted chat re-keys as part of the same request, so nothing sent afterwards is
     * readable with the keys that device holds. What it already received stays readable to it —
     * that is inherent, and the copy on screen says so rather than implying a remote wipe.
     */
    async revokeDevice(deviceId: string): Promise<void> {
        if (this.confirmingDevice() !== deviceId) {
            this.confirmingDevice.set(deviceId);
            return;
        }

        this.confirmingDevice.set(null);
        this.revoking.set(true);
        this.deviceError.set(null);

        try {
            await firstValueFrom(this.cryptoApi.revokeDevice(deviceId));
            await this.loadDevices();
        } catch {
            this.deviceError.set('Could not revoke that device.');
        } finally {
            this.revoking.set(false);
        }
    }

    cancelRevoke(): void {
        this.confirmingDevice.set(null);
    }

    /**
     * Rotate this device's medium-term signed prekey.
     *
     * Only offered for "This device": rotation re-seals the private bundle with the KEK held in
     * memory from unlock, which only the device that unlocked it has — there is no way to rotate a
     * prekey for a device this session did not unlock.
     */
    async rotatePrekey(): Promise<void> {
        if (this.rotatingPrekey()) {
            return;
        }

        this.rotatingPrekey.set(true);
        this.prekeyError.set(null);
        this.prekeyRotated.set(false);

        try {
            await this.keyStore.rotatePrekey();
            this.prekeyRotated.set(true);
            await this.loadDevices();
        } catch {
            this.prekeyError.set('Could not rotate the signed prekey. Please try again shortly.');
        } finally {
            this.rotatingPrekey.set(false);
        }
    }
}
