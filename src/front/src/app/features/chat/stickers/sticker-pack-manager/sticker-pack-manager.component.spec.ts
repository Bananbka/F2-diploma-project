import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { ProfileApiService } from '../../../../core/services/profile-api.service';
import { SessionService } from '../../../../core/services/session.service';
import { StickerApiService } from '../../../../core/services/sticker-api.service';
import { SettingsService } from '../../../settings/settings.service';
import { StickerPackManagerComponent } from './sticker-pack-manager.component';

describe('StickerPackManagerComponent (Stickers tab)', () => {
    function setup() {
        const stickerApi = jasmine.createSpyObj<StickerApiService>('StickerApiService', ['getMyPacks']);
        stickerApi.getMyPacks.and.returnValue(of([]));
        TestBed.configureTestingModule({
            imports: [StickerPackManagerComponent],
            providers: [
                provideRouter([]),
                { provide: StickerApiService, useValue: stickerApi },
                { provide: ProfileApiService, useValue: {} },
                { provide: SessionService, useValue: { user: signal({ id: 'u1' }) } },
            ],
        });
        const fixture = TestBed.createComponent(StickerPackManagerComponent);
        fixture.detectChanges();
        return { fixture, root: fixture.nativeElement as HTMLElement };
    }

    it('has no page header now that it lives inside the settings dialog', () => {
        const { root } = setup();
        expect(root.querySelector('header')).toBeNull();
        expect(root.querySelector('.back')).toBeNull();
    });

    it('counts a half-typed pack name as an unsaved change, and stops once it is gone', () => {
        const { fixture, root } = setup();
        const settings = TestBed.inject(SettingsService);
        expect(settings.hasUnsavedChanges()).toBeFalse();

        const input = root.querySelector<HTMLInputElement>('#newTitle')!;
        input.value = 'My pack';
        input.dispatchEvent(new Event('input'));
        expect(settings.hasUnsavedChanges()).toBeTrue();

        fixture.destroy();
        expect(settings.hasUnsavedChanges()).toBeFalse();
    });
});
