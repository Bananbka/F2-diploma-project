import { TestBed } from '@angular/core/testing';

import { ConfirmService } from '../../shared/ui/confirm-dialog/confirm.service';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
    let service: SettingsService;
    let confirm: jasmine.SpyObj<ConfirmService>;
    let opener: HTMLButtonElement;

    beforeEach(() => {
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);
        confirm.ask.and.resolveTo(true);
        TestBed.configureTestingModule({ providers: [{ provide: ConfirmService, useValue: confirm }] });
        service = TestBed.inject(SettingsService);
        opener = document.createElement('button');
        document.body.appendChild(opener);
    });

    afterEach(() => opener.remove());

    it('opens on the requested tab, defaulting to Profile', () => {
        service.open();
        expect(service.activeTab()).toBe('profile');
        service.close();
        service.open('privacy');
        expect(service.activeTab()).toBe('privacy');
    });

    it('returns focus to the opener on close', async () => {
        service.open('profile', opener);
        service.close();
        await Promise.resolve();
        expect(document.activeElement).toBe(opener);
    });

    it('reopening while open switches tab instead of replacing the remembered opener', async () => {
        service.open('profile', opener);
        const other = document.createElement('button');
        document.body.appendChild(other);
        service.open('stickers', other);
        await Promise.resolve();
        await Promise.resolve();
        expect(service.activeTab()).toBe('stickers');

        service.close();
        await Promise.resolve();
        expect(document.activeElement).toBe(opener);
        other.remove();
    });

    it('asks only when something is unsaved, and a refusal keeps everything as it was', async () => {
        service.open('profile', opener);
        expect(await service.requestClose()).toBeTrue();
        expect(confirm.ask).not.toHaveBeenCalled();

        service.open('profile', opener);
        const unregister = service.registerDirtyCheck(() => true);
        confirm.ask.and.resolveTo(false);
        expect(await service.requestClose()).toBeFalse();
        expect(await service.select('security')).toBeFalse();
        expect(service.activeTab()).toBe('profile');

        unregister();
        expect(service.hasUnsavedChanges()).toBeFalse();
        expect(await service.select('security')).toBeTrue();
    });

    it('closes unconditionally when told to (sign-out), forgetting dirty checks', () => {
        service.open('profile', opener);
        service.registerDirtyCheck(() => true);
        service.close();
        expect(service.isOpen()).toBeFalse();
        expect(service.hasUnsavedChanges()).toBeFalse();
    });

    it('asks with wording that is not specific to one tab', async () => {
        service.open('security', opener);
        service.registerDirtyCheck(() => true);
        await service.requestClose();
        expect(confirm.ask.calls.mostRecent().args[0].message).toBe(
            'You have unsaved changes. If you leave now they will be lost.'
        );
    });

    it('lands focus on the rail Settings button when there was no opener (cold-load deep link)', async () => {
        const trigger = document.createElement('button');
        trigger.setAttribute('data-settings-trigger', '');
        document.body.appendChild(trigger);
        (document.activeElement as HTMLElement | null)?.blur();

        service.open('profile');
        service.close();
        await Promise.resolve();

        expect(document.activeElement).toBe(trigger);
        trigger.remove();
    });
});
