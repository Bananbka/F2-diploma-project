import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Appearance, DEFAULT_APPEARANCE } from '../../../core/models/appearance.model';
import { AppearanceStore } from '../../../core/services/appearance-store.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { Folder } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { ToastService } from '../../../core/services/toast.service';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { FoldersSettingsComponent } from './folders-settings.component';

describe('FoldersSettingsComponent', () => {
    let fixture: ComponentFixture<FoldersSettingsComponent>;
    let root: HTMLElement;
    let appearance: { value: ReturnType<typeof signal<Appearance>>; update: jasmine.Spy };
    let folderStore: { folders: ReturnType<typeof signal<Folder[]>>; remove: jasmine.Spy };
    let confirm: jasmine.SpyObj<ConfirmService>;

    const folder: Folder = { id: 'f1', title: 'Work', icon: null, items: [{ chat_id: 'c1' }, { chat_id: 'c2' }] };

    beforeEach(() => {
        appearance = { value: signal<Appearance>(DEFAULT_APPEARANCE), update: jasmine.createSpy('update') };
        folderStore = { folders: signal<Folder[]>([folder]), remove: jasmine.createSpy('remove').and.resolveTo(true) };
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);
        confirm.ask.and.resolveTo(true);
        TestBed.configureTestingModule({
            providers: [
                { provide: AppearanceStore, useValue: appearance },
                { provide: FolderStoreService, useValue: folderStore },
                { provide: ChatStoreService, useValue: { chats: signal([]) } },
                { provide: ConfirmService, useValue: confirm },
                { provide: ToastService, useValue: { error: () => {} } },
            ],
        });
        fixture = TestBed.createComponent(FoldersSettingsComponent);
        fixture.detectChanges();
        root = fixture.nativeElement as HTMLElement;
    });

    const switchFor = (label: string) =>
        root.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label$="${label}"]`)!;

    it('lists the six default views, all visible, with a switch each', () => {
        expect(root.querySelectorAll('button[role="switch"]').length).toBe(6);
        expect(switchFor('Unread').getAttribute('aria-checked')).toBe('true');
    });

    it('hiding a view writes hidden_views to the store', () => {
        switchFor('Unread').click();
        expect(appearance.update).toHaveBeenCalledWith({ hidden_views: ['unread'] });
    });

    it('showing a hidden view removes it from the list', () => {
        appearance.value.set({ ...DEFAULT_APPEARANCE, hidden_views: ['unread', 'contacts'] });
        fixture.detectChanges();
        expect(switchFor('Unread').getAttribute('aria-checked')).toBe('false');
        switchFor('Unread').click();
        expect(appearance.update).toHaveBeenCalledWith({ hidden_views: ['contacts'] });
    });

    it('disables the switch of the last visible chat view and says why', () => {
        appearance.value.set({ ...DEFAULT_APPEARANCE, hidden_views: ['direct', 'groups', 'channels', 'unread'] });
        fixture.detectChanges();
        const last = switchFor('All chats');
        expect(last.disabled).toBeTrue();
        expect(root.querySelector('#view-note-all')?.textContent).toContain('last visible chat view');
        expect(last.getAttribute('aria-describedby')).toBe('view-note-all');
    });

    it('Restore all default views clears the list', () => {
        appearance.value.set({ ...DEFAULT_APPEARANCE, hidden_views: ['unread'] });
        fixture.detectChanges();
        const restore = Array.from(root.querySelectorAll<HTMLButtonElement>('.link')).find((b) =>
            b.textContent?.includes('Restore all default views')
        )!;
        restore.click();
        expect(appearance.update).toHaveBeenCalledWith({ hidden_views: [] });
    });

    it('lists my folders with their chat counts', () => {
        expect(root.textContent).toContain('Work');
        expect(root.textContent).toContain('2 chats');
    });

    it('New folder, Edit and Rename open the shared dialog', () => {
        root.querySelector<HTMLButtonElement>('.primary')!.click();
        fixture.detectChanges();
        expect(root.querySelector('app-folder-edit-dialog')).not.toBeNull();
        fixture.componentInstance.dialog.set(null);
        fixture.detectChanges();
        root.querySelector<HTMLButtonElement>('button[aria-label="Rename Work"]')!.click();
        expect(fixture.componentInstance.dialog()).toEqual({ folder, focus: 'name' });
        root.querySelector<HTMLButtonElement>('button[aria-label="Edit chats in Work"]')!.click();
        expect(fixture.componentInstance.dialog()).toEqual({ folder, focus: 'chats' });
    });

    it('Delete asks first, then removes through the store', async () => {
        await fixture.componentInstance.remove(folder);
        expect(confirm.ask).toHaveBeenCalled();
        expect(folderStore.remove).toHaveBeenCalledWith(folder);
    });

    it('Delete does nothing when declined', async () => {
        confirm.ask.and.resolveTo(false);
        await fixture.componentInstance.remove(folder);
        expect(folderStore.remove).not.toHaveBeenCalled();
    });

    it('shows an empty state with no folders', () => {
        folderStore.folders.set([]);
        fixture.detectChanges();
        expect(root.textContent).toContain('You have no folders yet');
    });
});
