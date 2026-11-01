import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { UserProfile } from '../../../core/models/chat.model';
import { SessionService } from '../../../core/services/session.service';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { StickerPackManagerComponent } from '../../chat/stickers/sticker-pack-manager/sticker-pack-manager.component';
import { PrivacyComponent } from '../privacy/privacy.component';
import { ProfileComponent } from '../profile/profile.component';
import { SecurityComponent } from '../security/security.component';
import { SettingsService } from '../settings.service';
import { SettingsModalComponent } from './settings-modal.component';

const ME = { id: 'u1', full_name: 'Ada', username: 'ada_lovelace' } as UserProfile;

@Component({
    selector: 'app-profile',
    template: '<p id="stub-profile">profile</p>',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class StubProfileComponent {}
@Component({
    selector: 'app-security',
    template: '<p id="stub-security">security</p>',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class StubSecurityComponent {}
@Component({
    selector: 'app-sticker-pack-manager',
    template: '<p id="stub-stickers">stickers</p>',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class StubStickersComponent {}
@Component({
    selector: 'app-privacy',
    template: '<p id="stub-privacy">privacy</p>',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class StubPrivacyComponent {}

describe('SettingsModalComponent', () => {
    let fixture: ComponentFixture<SettingsModalComponent>;
    let root: HTMLElement;
    let settings: SettingsService;
    let user: ReturnType<typeof signal<UserProfile | null>>;
    let isRestored: ReturnType<typeof signal<boolean>>;
    let confirm: jasmine.SpyObj<ConfirmService>;
    let opener: HTMLButtonElement;

    const tabs = () => [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const panel = () => root.querySelector<HTMLElement>('[role="tabpanel"]')!;
    const key = (target: Element, init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        fixture.detectChanges();
        return event;
    };

    beforeEach(async () => {
        user = signal<UserProfile | null>(ME);
        isRestored = signal(true);
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);
        confirm.ask.and.resolveTo(true);

        TestBed.configureTestingModule({
            imports: [SettingsModalComponent],
            providers: [
                { provide: SessionService, useValue: { user, isRestored } },
                { provide: ConfirmService, useValue: confirm },
            ],
        });
        TestBed.overrideComponent(SettingsModalComponent, {
            remove: { imports: [ProfileComponent, SecurityComponent, StickerPackManagerComponent, PrivacyComponent] },
            add: {
                imports: [StubProfileComponent, StubSecurityComponent, StubStickersComponent, StubPrivacyComponent],
            },
        });
        await TestBed.compileComponents();

        opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();

        settings = TestBed.inject(SettingsService);
        settings.open('profile', opener);

        fixture = TestBed.createComponent(SettingsModalComponent);
        root = fixture.nativeElement as HTMLElement;
        document.body.appendChild(root);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    });

    afterEach(() => {
        root.remove();
        opener.remove();
    });

    it('is a labelled modal dialog with a tab per section', () => {
        const dialog = root.querySelector('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('settings-title');
        expect(tabs().map((t) => t.textContent!.trim())).toEqual(['Profile', 'Security', 'Stickers', 'Privacy & data']);
    });

    it('starts on Profile with the active tab focused and the others out of the tab order', () => {
        expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
        expect(
            tabs()
                .slice(1)
                .every((t) => t.getAttribute('aria-selected') === 'false' && t.tabIndex === -1)
        ).toBeTrue();
        expect(document.activeElement).toBe(tabs()[0]);
        expect(panel().querySelector('#stub-profile')).toBeTruthy();
        expect(panel().getAttribute('aria-labelledby')).toBe('settings-tab-profile');
    });

    it('shows the matching section for each tab', async () => {
        const expected = ['profile', 'security', 'stickers', 'privacy'];
        for (let i = 0; i < tabs().length; i++) {
            tabs()[i].click();
            await fixture.whenStable();
            fixture.detectChanges();
            expect(panel().querySelector(`#stub-${expected[i]}`))
                .withContext(expected[i])
                .toBeTruthy();
            expect(panel().querySelectorAll('p').length).toBe(1);
            expect(tabs()[i].getAttribute('aria-selected')).toBe('true');
        }
    });

    it('moves focus with the arrow keys, wrapping, without selecting', () => {
        key(tabs()[0], { key: 'ArrowDown' });
        expect(document.activeElement).toBe(tabs()[1]);
        expect(settings.activeTab()).toBe('profile');

        key(tabs()[1], { key: 'ArrowUp' });
        key(tabs()[0], { key: 'ArrowUp' });
        expect(document.activeElement).toBe(tabs()[3]);

        key(tabs()[3], { key: 'Home' });
        expect(document.activeElement).toBe(tabs()[0]);
        key(tabs()[0], { key: 'End' });
        expect(document.activeElement).toBe(tabs()[3]);
        key(tabs()[3], { key: 'ArrowRight' });
        expect(document.activeElement).toBe(tabs()[0]);
    });

    it('closes on Escape and returns focus to the button that opened it', async () => {
        key(root.querySelector('[role="dialog"]')!, { key: 'Escape' });
        await fixture.whenStable();
        await Promise.resolve();

        expect(settings.isOpen()).toBeFalse();
        expect(document.activeElement).toBe(opener);
    });

    it('closes from the close button and from a click on the backdrop, but not from a click inside', async () => {
        (root.querySelector('.card') as HTMLElement).click();
        expect(settings.isOpen()).toBeTrue();

        (root.querySelector('.scrim') as HTMLElement).click();
        await fixture.whenStable();
        expect(settings.isOpen()).toBeFalse();

        settings.open('profile', opener);
        fixture.detectChanges();
        (root.querySelector('.close') as HTMLButtonElement).click();
        await fixture.whenStable();
        expect(settings.isOpen()).toBeFalse();
    });

    it('keeps Escape from an inner dialog from closing the settings dialog', () => {
        const inner = document.createElement('div');
        inner.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        root.querySelector('.panel')!.appendChild(inner);

        key(inner, { key: 'Escape' });
        expect(settings.isOpen()).toBeTrue();
    });

    it('traps Tab inside the dialog', () => {
        const items = [...root.querySelectorAll<HTMLElement>('button, [tabindex="0"]')];
        const last = items[items.length - 1];
        last.focus();

        const event = key(last, { key: 'Tab' });
        expect(event.defaultPrevented).toBeTrue();
        expect(root.contains(document.activeElement)).toBeTrue();
        expect(document.activeElement).toBe(items[0]);

        const back = key(items[0], { key: 'Tab', shiftKey: true });
        expect(back.defaultPrevented).toBeTrue();
        expect(document.activeElement).toBe(last);
    });

    it('asks before closing or switching tab when there are unsaved changes, and honours "keep editing"', async () => {
        settings.registerDirtyCheck(() => true);
        confirm.ask.and.resolveTo(false);

        key(root.querySelector('[role="dialog"]')!, { key: 'Escape' });
        await fixture.whenStable();
        expect(confirm.ask).toHaveBeenCalledTimes(1);
        expect(settings.isOpen()).toBeTrue();

        tabs()[1].click();
        await fixture.whenStable();
        expect(confirm.ask).toHaveBeenCalledTimes(2);
        expect(settings.activeTab()).toBe('profile');

        confirm.ask.and.resolveTo(true);
        tabs()[1].click();
        await fixture.whenStable();
        expect(settings.activeTab()).toBe('security');
    });

    it('does not ask when nothing is unsaved', async () => {
        tabs()[1].click();
        await fixture.whenStable();
        expect(confirm.ask).not.toHaveBeenCalled();
        expect(settings.activeTab()).toBe('security');
    });

    it('closes when the session ends', async () => {
        user.set(null);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(settings.isOpen()).toBeFalse();
    });

    it('stays open while the session is merely being restored', async () => {
        isRestored.set(false);
        user.set(null);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(settings.isOpen()).toBeTrue();

        isRestored.set(true);
        user.set(ME);
        fixture.detectChanges();
        expect(settings.isOpen()).toBeTrue();
    });

    it('closes on Escape pressed anywhere in the document while open', async () => {
        (document.activeElement as HTMLElement).blur();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await fixture.whenStable();
        expect(settings.isOpen()).toBeFalse();
    });

    it('stops listening for Escape once destroyed', () => {
        fixture.destroy();
        settings.open('profile', opener);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(settings.isOpen()).toBeTrue();
    });
});
