import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { OwnIdentity } from '../../../core/models/crypto.model';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { DevicesComponent } from './devices.component';

function identity(id: string, name: string): OwnIdentity {
    return {
        device_id: id,
        display_name: name,
        version: 1,
        created_at: '2025-01-02T00:00:00Z',
        signed_prekey_created_at: null,
    } as unknown as OwnIdentity;
}

describe('DevicesComponent (Security tab)', () => {
    let fixture: ComponentFixture<DevicesComponent>;
    let component: DevicesComponent;
    let root: HTMLElement;
    let cryptoApi: jasmine.SpyObj<CryptoApiService>;
    let keyStore: jasmine.SpyObj<KeyStoreService>;

    async function render(devices: OwnIdentity[]): Promise<void> {
        cryptoApi.getOwnIdentities.and.returnValue(of(devices));
        fixture = TestBed.createComponent(DevicesComponent);
        component = fixture.componentInstance;
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    }

    const buttonLabelled = (label: string) =>
        [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === label);

    beforeEach(() => {
        cryptoApi = jasmine.createSpyObj<CryptoApiService>('CryptoApiService', ['getOwnIdentities', 'revokeDevice']);
        keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', ['rotatePrekey']);
        Object.defineProperty(keyStore, 'deviceId', { get: () => 'd1' });
        keyStore.rotatePrekey.and.resolveTo();

        TestBed.configureTestingModule({
            imports: [DevicesComponent],
            providers: [
                { provide: CryptoApiService, useValue: cryptoApi },
                { provide: KeyStoreService, useValue: keyStore },
            ],
        });
    });

    it('lists devices and marks the current one', async () => {
        await render([identity('d1', 'Laptop'), identity('d2', 'Phone')]);
        const rows = root.querySelectorAll('.device');
        expect(rows.length).toBe(2);
        expect(rows[0].textContent).toContain('This device');
        expect(rows[1].textContent).not.toContain('This device');
    });

    it('offers rotation only for this device and revocation only for the others', async () => {
        await render([identity('d1', 'Laptop'), identity('d2', 'Phone')]);
        expect(root.querySelectorAll('button[aria-label^="Rotate"]').length).toBe(1);
        expect(root.querySelectorAll('button[aria-label^="Revoke"]').length).toBe(1);
        expect(root.querySelector('button[aria-label="Revoke Laptop"]')).toBeNull();
    });

    it('does not offer revoking when it is the only device', async () => {
        await render([identity('d1', 'Laptop')]);
        expect(root.querySelector('button[aria-label^="Revoke"]')).toBeNull();
    });

    it('revokes in two steps and reloads the list', async () => {
        await render([identity('d1', 'Laptop'), identity('d2', 'Phone')]);
        cryptoApi.revokeDevice.and.returnValue(of({ message: 'ok' }));

        (root.querySelector('button[aria-label="Revoke Phone"]') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(cryptoApi.revokeDevice).not.toHaveBeenCalled();
        expect(buttonLabelled('Revoke?')).toBeTruthy();

        cryptoApi.getOwnIdentities.and.returnValue(of([identity('d1', 'Laptop')]));
        buttonLabelled('Revoke?')!.click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(cryptoApi.revokeDevice).toHaveBeenCalledOnceWith('d2');
        expect(root.querySelectorAll('.device').length).toBe(1);
    });

    it('lets the user back out of an armed revoke', async () => {
        await render([identity('d1', 'Laptop'), identity('d2', 'Phone')]);
        (root.querySelector('button[aria-label="Revoke Phone"]') as HTMLButtonElement).click();
        fixture.detectChanges();
        buttonLabelled('Cancel')!.click();
        fixture.detectChanges();

        expect(cryptoApi.revokeDevice).not.toHaveBeenCalled();
        expect(root.querySelector('button[aria-label="Revoke Phone"]')).toBeTruthy();
    });

    it('rotates the prekey and confirms it', async () => {
        await render([identity('d1', 'Laptop')]);
        await component.rotatePrekey();
        fixture.detectChanges();

        expect(keyStore.rotatePrekey).toHaveBeenCalled();
        expect(root.querySelector('.saved-line')?.textContent).toContain('Signed prekey rotated');
    });

    it('reports a failed rotation and a failed load', async () => {
        await render([identity('d1', 'Laptop')]);
        keyStore.rotatePrekey.and.rejectWith(new Error('nope'));
        await component.rotatePrekey();
        fixture.detectChanges();
        expect(root.textContent).toContain('Could not rotate the signed prekey');

        cryptoApi.getOwnIdentities.and.returnValue(throwError(() => new Error('down')));
        fixture = TestBed.createComponent(DevicesComponent);
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(root.textContent).toContain('Could not load your devices.');
    });
});
