import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { UserProfile } from '../../../core/models/chat.model';
import { ProfileApiService } from '../../../core/services/profile-api.service';
import { SessionService } from '../../../core/services/session.service';
import { SettingsService } from '../settings.service';
import { ProfileComponent } from './profile.component';

const ME = {
    id: 'u1',
    full_name: 'Ada Lovelace',
    username: 'ada_lovelace',
    email: 'ada@example.test',
    phone_number: '+380501234567',
    bio: 'Hello',
    avatar_url: null,
} as UserProfile;

async function pngFile(): Promise<File> {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 200;
    canvas.getContext('2d')!.fillRect(0, 0, 300, 200);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    return new File([blob], 'me.png', { type: 'image/png' });
}

describe('ProfileComponent (Profile tab)', () => {
    let fixture: ComponentFixture<ProfileComponent>;
    let component: ProfileComponent;
    let root: HTMLElement;
    let profileApi: jasmine.SpyObj<ProfileApiService>;
    let user: ReturnType<typeof signal<UserProfile | null>>;
    let settings: SettingsService;

    beforeEach(async () => {
        user = signal<UserProfile | null>(ME);
        profileApi = jasmine.createSpyObj<ProfileApiService>('ProfileApiService', ['upload', 'updateProfile']);
        profileApi.upload.and.returnValue(
            of({ url: 'http://x/avatars/new.webp', name: 'a', size: 1, content_type: 'image/webp' })
        );
        profileApi.updateProfile.and.callFake((data) =>
            of({ ...ME, ...data, avatar_url: undefined } as unknown as UserProfile)
        );

        await TestBed.configureTestingModule({
            imports: [ProfileComponent],
            providers: [
                { provide: ProfileApiService, useValue: profileApi },
                { provide: SessionService, useValue: { user } },
            ],
        }).compileComponents();

        settings = TestBed.inject(SettingsService);
        fixture = TestBed.createComponent(ProfileComponent);
        component = fixture.componentInstance;
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();
    });

    function pick(file: File): void {
        const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
        const data = new DataTransfer();
        data.items.add(file);
        input.files = data.files;
        input.dispatchEvent(new Event('change'));
        fixture.detectChanges();
    }

    it('shows the editable fields and the email and phone read-only', () => {
        expect((root.querySelector('#fullName') as HTMLInputElement).value).toBe('Ada Lovelace');
        expect((root.querySelector('#username') as HTMLInputElement).value).toBe('ada_lovelace');
        expect((root.querySelector('#bio') as HTMLTextAreaElement).value).toBe('Hello');
        expect((root.querySelector('#email') as HTMLInputElement).readOnly).toBeTrue();
        expect((root.querySelector('#email') as HTMLInputElement).value).toBe('ada@example.test');
        expect((root.querySelector('#phone') as HTMLInputElement).readOnly).toBeTrue();
    });

    it('no longer carries the sticker, password, device or deletion sections', () => {
        const text = root.textContent!;
        expect(text).not.toContain('sticker packs');
        expect(text).not.toContain('Change password');
        expect(text).not.toContain('Your devices');
        expect(text).not.toContain('Delete account');
    });

    it('opens the cropper instead of uploading straight away', async () => {
        pick(await pngFile());

        expect(root.querySelector('app-avatar-cropper')).toBeTruthy();
        expect(profileApi.upload).not.toHaveBeenCalled();
    });

    it('uploads the cropped file through the avatar path and holds it until the profile is saved', async () => {
        pick(await pngFile());
        const cropped = new File(['x'], 'avatar.webp', { type: 'image/webp' });

        await component.onCropApplied(cropped);
        fixture.detectChanges();

        expect(profileApi.upload).toHaveBeenCalledWith(cropped, 'avatar');
        expect(component.avatarUrl()).toBe('http://x/avatars/new.webp');
        expect(root.querySelector('app-avatar-cropper')).toBeNull();
        expect(profileApi.updateProfile).not.toHaveBeenCalled();

        await component.save();
        expect(profileApi.updateProfile.calls.mostRecent().args[0].avatar_url).toBe('http://x/avatars/new.webp');
        expect(user()!.avatar_url).toBe('http://x/avatars/new.webp');
    });

    it('discards a cancelled crop without uploading or marking anything unsaved', async () => {
        pick(await pngFile());
        component.cancelCrop();
        fixture.detectChanges();

        expect(root.querySelector('app-avatar-cropper')).toBeNull();
        expect(profileApi.upload).not.toHaveBeenCalled();
        expect(settings.hasUnsavedChanges()).toBeFalse();
    });

    it('reports a failed upload', async () => {
        profileApi.upload.and.returnValue(throwError(() => new Error('boom')));
        await component.onCropApplied(new File(['x'], 'a.webp'));
        fixture.detectChanges();

        expect(root.querySelector('.error')?.textContent).toContain('Could not upload that image.');
        expect(component.avatarUrl()).toBeNull();
    });

    it('registers its unsaved state with the settings dialog, and clears it on save', async () => {
        expect(settings.hasUnsavedChanges()).toBeFalse();

        const bio = root.querySelector('#bio') as HTMLTextAreaElement;
        bio.value = 'Something new';
        bio.dispatchEvent(new Event('input'));
        expect(settings.hasUnsavedChanges()).toBeTrue();

        await component.save();
        expect(settings.hasUnsavedChanges()).toBeFalse();
    });

    it('stops reporting unsaved state once it is gone', () => {
        component.form.controls.bio.markAsDirty();
        expect(settings.hasUnsavedChanges()).toBeTrue();
        fixture.destroy();
        expect(settings.hasUnsavedChanges()).toBeFalse();
    });

    it('does not save an invalid form', async () => {
        component.form.controls.username.setValue('ab');
        await component.save();
        expect(profileApi.updateProfile).not.toHaveBeenCalled();
    });

    it('sends an emptied bio as null so it is actually cleared', async () => {
        component.form.controls.bio.setValue('   ');
        await component.save();
        expect(profileApi.updateProfile.calls.mostRecent().args[0].bio).toBeNull();
    });

    it('leaves an untouched bio and avatar out of the request', async () => {
        await component.save();
        const payload = profileApi.updateProfile.calls.mostRecent().args[0];
        expect('bio' in payload).toBeFalse();
        expect('avatar_url' in payload).toBeFalse();
    });

    it('removes the photo: offered only when there is one, sent as null on save, counted as unsaved', async () => {
        expect(root.textContent).not.toContain('Remove photo');

        user.set({ ...ME, avatar_url: 'http://x/avatars/old.webp' });
        fixture.destroy();
        fixture = TestBed.createComponent(ProfileComponent);
        component = fixture.componentInstance;
        root = fixture.nativeElement as HTMLElement;
        fixture.detectChanges();

        const remove = [...root.querySelectorAll('button')].find((b) => b.textContent!.includes('Remove photo'))!;
        remove.click();
        fixture.detectChanges();
        expect(component.avatarUrl()).toBeNull();
        expect(settings.hasUnsavedChanges()).toBeTrue();

        await component.save();
        expect(profileApi.updateProfile.calls.mostRecent().args[0].avatar_url).toBeNull();
        expect(user()!.avatar_url).toBeNull();
    });

    it('keeps the cropped result when the upload fails and retries it without re-cropping', async () => {
        profileApi.upload.and.returnValue(throwError(() => new Error('down')));
        const cropped = new File(['x'], 'avatar.webp', { type: 'image/webp' });
        await component.onCropApplied(cropped);
        fixture.detectChanges();
        expect(component.failedUpload()).toBe(cropped);

        profileApi.upload.and.returnValue(
            of({ url: 'http://x/avatars/ok.webp', name: 'a', size: 1, content_type: 'image/webp' })
        );
        (root.querySelector('.retry') as HTMLButtonElement).click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(profileApi.upload).toHaveBeenCalledTimes(2);
        expect(profileApi.upload.calls.mostRecent().args[0]).toBe(cropped);
        expect(component.avatarUrl()).toBe('http://x/avatars/ok.webp');
        expect(component.failedUpload()).toBeNull();
    });
});
