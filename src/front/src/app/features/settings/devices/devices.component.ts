import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LucideAngularModule, RefreshCw } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { KeyStoreService } from '../../../core/services/key-store.service';

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

/** The device list on the Security tab: revoke a lost device, rotate this device's signed prekey. */
@Component({
    selector: 'app-devices',
    imports: [LucideAngularModule, DatePipe],
    templateUrl: './devices.component.html',
    styleUrl: './devices.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevicesComponent {
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly keyStore = inject(KeyStoreService);

    readonly devices = signal<DeviceRow[]>([]);
    readonly devicesLoading = signal(true);
    readonly revoking = signal(false);
    readonly deviceError = signal<string | null>(null);
    /** The device id whose revoke button is armed, if any. */
    readonly confirmingDevice = signal<string | null>(null);

    readonly rotatingPrekey = signal(false);
    readonly prekeyRotated = signal(false);
    readonly prekeyError = signal<string | null>(null);

    readonly rotateIcon = RefreshCw;

    constructor() {
        void this.loadDevices();
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
