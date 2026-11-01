import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SessionService } from '../../../core/services/session.service';
import { SettingsService } from '../settings.service';
import { ChangePasswordComponent } from './change-password.component';

describe('ChangePasswordComponent (Security tab)', () => {
    let fixture: ComponentFixture<ChangePasswordComponent>;
    let component: ChangePasswordComponent;
    let root: HTMLElement;
    let session: jasmine.SpyObj<SessionService>;

    beforeEach(() => {
        session = jasmine.createSpyObj<SessionService>('SessionService', ['changePassword']);
        session.changePassword.and.resolveTo();
        TestBed.configureTestingModule({
            imports: [ChangePasswordComponent],
            providers: [{ provide: SessionService, useValue: session }],
        });
        fixture = TestBed.createComponent(ChangePasswordComponent);
        component = fixture.componentInstance;
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();
    });

    function fill(oldPassword: string, newPassword: string, confirm: string): void {
        component.form.setValue({ oldPassword, newPassword, confirm });
    }

    it('has no page header of its own any more', () => {
        expect(root.querySelector('header')).toBeNull();
        expect(root.querySelector('.back')).toBeNull();
    });

    it('does not submit a mismatched or too-short password', async () => {
        fill('old-password-123', 'short', 'short');
        await component.submit();
        fill('old-password-123', 'a-long-new-password', 'a-different-one');
        await component.submit();

        expect(session.changePassword).not.toHaveBeenCalled();
    });

    it('changes the password, shows the result, and returns to a blank form on Done', async () => {
        fill('old-password-123', 'a-long-new-password', 'a-long-new-password');
        await component.submit();
        fixture.detectChanges();

        expect(session.changePassword).toHaveBeenCalledWith('old-password-123', 'a-long-new-password');
        expect(root.textContent).toContain('Password changed');

        (root.querySelector('.submit') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(component.phase()).toBe('input');
        expect(component.form.getRawValue().newPassword).toBe('');
    });

    it('says so when the current password is wrong', async () => {
        session.changePassword.and.rejectWith(new HttpErrorResponse({ status: 401 }));
        fill('wrong-password-1', 'a-long-new-password', 'a-long-new-password');
        await component.submit();
        fixture.detectChanges();

        expect(root.querySelector('[role="alert"]')?.textContent).toContain('not your current password');
        expect(component.phase()).toBe('input');
    });

    it('counts typed passwords as unsaved changes for the settings dialog, until submitted', async () => {
        const settings = TestBed.inject(SettingsService);
        expect(settings.hasUnsavedChanges()).toBeFalse();

        component.form.controls.oldPassword.markAsDirty();
        expect(settings.hasUnsavedChanges()).toBeTrue();

        fill('old-password-123', 'a-long-new-password', 'a-long-new-password');
        await component.submit();
        component.reset();
        expect(settings.hasUnsavedChanges()).toBeFalse();
    });
});
