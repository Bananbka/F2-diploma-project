import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { SessionService } from '../../../core/services/session.service';
import { SettingsService } from '../settings.service';
import { PrivacyComponent } from './privacy.component';

describe('PrivacyComponent (Privacy & data tab)', () => {
    let fixture: ComponentFixture<PrivacyComponent>;
    let component: PrivacyComponent;
    let root: HTMLElement;
    let session: jasmine.SpyObj<SessionService>;
    let navigate: jasmine.Spy;
    let settings: SettingsService;

    const dialog = () => root.querySelector<HTMLElement>('[role="dialog"]');
    const open = () => {
        (root.querySelector('.tile.is-danger') as HTMLButtonElement).click();
        fixture.detectChanges();
    };

    beforeEach(() => {
        session = jasmine.createSpyObj<SessionService>('SessionService', ['deleteAccount']);
        session.deleteAccount.and.resolveTo();

        TestBed.configureTestingModule({
            imports: [PrivacyComponent],
            providers: [provideRouter([]), { provide: SessionService, useValue: session }],
        });
        navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        settings = TestBed.inject(SettingsService);

        fixture = TestBed.createComponent(PrivacyComponent);
        component = fixture.componentInstance;
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();
    });

    function type(password: string): void {
        const input = root.querySelector<HTMLInputElement>('#deletePassword')!;
        input.value = password;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
    }

    it('states what is private and offers account deletion, and nothing that has no backend', () => {
        expect(root.textContent).toContain('end-to-end encrypted');
        expect(root.textContent).toContain('Delete account');
        expect(root.textContent).not.toContain('Read receipts');
    });

    it('opens a labelled modal that explains the consequences, with the dangerous button disabled until a password is typed', () => {
        open();
        expect(dialog()!.getAttribute('aria-modal')).toBe('true');
        expect(dialog()!.textContent).toContain('This is permanent and cannot be undone');
        const confirmButton = root.querySelector('.dialog-confirm') as HTMLButtonElement;
        expect(confirmButton.disabled).toBeTrue();

        type('hunter2');
        expect(confirmButton.disabled).toBeFalse();
    });

    it('closes on Escape without letting the key reach the settings dialog', () => {
        open();
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        let reachedParent = false;
        root.parentElement?.addEventListener('keydown', () => (reachedParent = true));
        document.body.appendChild(root);
        document.body.addEventListener('keydown', () => (reachedParent = true), { once: true });
        dialog()!.dispatchEvent(event);
        fixture.detectChanges();

        expect(dialog()).toBeNull();
        expect(reachedParent).toBeFalse();
        root.remove();
    });

    it('deletes the account, closes settings and leaves for the login page', async () => {
        settings.open('privacy');
        open();
        type('correct horse');
        await component.confirmDelete();

        expect(session.deleteAccount).toHaveBeenCalledWith('correct horse');
        expect(settings.isOpen()).toBeFalse();
        expect(navigate).toHaveBeenCalledWith(['/login']);
    });

    it('keeps the dialog open and says nothing was deleted on a wrong password', async () => {
        session.deleteAccount.and.rejectWith(new HttpErrorResponse({ status: 401 }));
        open();
        type('wrong');
        await component.confirmDelete();
        fixture.detectChanges();

        expect(dialog()).toBeTruthy();
        expect(root.querySelector('[role="alert"]')?.textContent).toContain('has not been deleted');
        expect(navigate).not.toHaveBeenCalled();
    });

    it('explains rate limiting and generic failures', async () => {
        open();
        type('x');
        session.deleteAccount.and.rejectWith(new HttpErrorResponse({ status: 429 }));
        await component.confirmDelete();
        expect(component.deleteError()).toContain('Too many attempts');

        session.deleteAccount.and.rejectWith(new HttpErrorResponse({ status: 500 }));
        await component.confirmDelete();
        expect(component.deleteError()).toContain('Nothing was changed');
    });

    it('cannot be dismissed while the request is in flight', async () => {
        let finish!: () => void;
        session.deleteAccount.and.returnValue(new Promise<void>((resolve) => (finish = resolve)));
        open();
        type('pw');
        const pending = component.confirmDelete();
        component.closeDelete();
        expect(component.deleteOpen()).toBeTrue();

        finish();
        await pending;
    });
});
