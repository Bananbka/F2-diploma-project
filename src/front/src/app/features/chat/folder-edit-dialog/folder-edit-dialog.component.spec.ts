import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Chat } from '../../../core/models/chat.model';
import { Folder } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { FolderEditDialogComponent } from './folder-edit-dialog.component';

function chat(id: string, title: string): Chat {
    return {
        id,
        chat_type: 'group',
        title,
        avatar_url: null,
        unread_count: 0,
        last_message: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
        participants: [],
        muted_until: null,
        is_muted: false,
    };
}

const CHATS = [chat('a', 'Alpha'), chat('b', 'Beta'), chat('c', 'Gamma')];
const FOLDER: Folder = { id: 'f1', title: 'Work', items: [{ chat_id: 'b' }] };

describe('FolderEditDialogComponent', () => {
    let fixture: ComponentFixture<FolderEditDialogComponent>;
    let host: HTMLElement;
    let store: jasmine.SpyObj<FolderStoreService>;
    let closed: number;

    async function open(folder: Folder | null, focus: 'name' | 'chats' = 'name'): Promise<void> {
        fixture = TestBed.createComponent(FolderEditDialogComponent);
        fixture.componentRef.setInput('folder', folder);
        fixture.componentRef.setInput('chats', CHATS);
        fixture.componentRef.setInput('focus', focus);
        closed = 0;
        fixture.componentInstance.closed.subscribe(() => closed++);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        host = fixture.nativeElement as HTMLElement;
    }

    const rows = () => Array.from(host.querySelectorAll<HTMLInputElement>('.chat-row input'));
    const field = (selector: string) => host.querySelector<HTMLInputElement>(selector)!;

    function type(input: HTMLInputElement, value: string): void {
        input.value = value;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
    }

    beforeEach(() => {
        store = jasmine.createSpyObj<FolderStoreService>('FolderStoreService', ['create', 'update']);
        store.create.and.resolveTo({ id: 'new', title: 'x', items: [] });
        store.update.and.resolveTo(true);
        TestBed.configureTestingModule({ providers: [{ provide: FolderStoreService, useValue: store }] });
    });

    it('creates a folder from a name and the ticked chats', async () => {
        await open(null);
        expect(host.querySelector('h2')?.textContent).toContain('New folder');
        expect(document.activeElement).toBe(field('input[type="text"]'));
        expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBeTrue();

        type(field('input[type="text"]'), '  Friends ');
        rows()[0].click();
        rows()[2].click();
        host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await fixture.whenStable();

        expect(store.create).toHaveBeenCalledWith('Friends', ['a', 'c']);
        expect(closed).toBe(1);
    });

    it('edits an existing folder: name and the complete chat set', async () => {
        await open(FOLDER);
        expect(host.querySelector('h2')?.textContent).toContain('Edit folder');
        expect(field('input[type="text"]').value).toBe('Work');
        // Members float to the top, and start ticked.
        expect(rows().map((r) => r.checked)).toEqual([true, false, false]);

        type(field('input[type="text"]'), 'Office');
        rows()[0].click(); // untick Beta
        rows()[1].click(); // tick Alpha
        host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await fixture.whenStable();

        expect(store.update).toHaveBeenCalledWith('f1', { title: 'Office', chatIds: ['a'] });
    });

    it('sends no chat_ids on a rename, and nothing at all when nothing changed', async () => {
        await open(FOLDER);
        type(field('input[type="text"]'), 'Office');
        host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await fixture.whenStable();
        expect(store.update).toHaveBeenCalledWith('f1', { title: 'Office' });

        store.update.calls.reset();
        await open(FOLDER);
        host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await fixture.whenStable();
        expect(store.update).not.toHaveBeenCalled();
        expect(closed).toBe(1);
    });

    it('sends only the chats when only the chats changed', async () => {
        await open(FOLDER);
        rows()[1].click();
        host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await fixture.whenStable();
        expect(store.update).toHaveBeenCalledWith('f1', { chatIds: ['b', 'a'] });
    });

    it('lands on the chat search when asked to edit chats', async () => {
        await open(FOLDER, 'chats');
        expect(document.activeElement).toBe(field('input[type="search"]'));
    });

    it('filters the chat list by the search box', async () => {
        await open(null);
        type(field('input[type="search"]'), 'gam');
        expect(host.querySelectorAll('.chat-row').length).toBe(1);
        expect(host.querySelector('.chat-name')?.textContent).toContain('Gamma');
    });

    it('stays open with its input when the save fails', async () => {
        store.update.and.resolveTo(false);
        await open(FOLDER);
        type(field('input[type="text"]'), 'Office');
        host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(closed).toBe(0);
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
        expect(field('input[type="text"]').value).toBe('Office');
    });

    it('closes on Escape pressed inside it, without swallowing an Escape aimed elsewhere', async () => {
        await open(null);
        const outside = jasmine.createSpy('outside');
        document.addEventListener('keydown', outside);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(closed).toBe(0);
        expect(outside).toHaveBeenCalledTimes(1);

        field('input[type="text"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(closed).toBe(1);
        expect(outside).toHaveBeenCalledTimes(1);
        document.removeEventListener('keydown', outside);
    });

    it('closes on Cancel', async () => {
        await open(null);

        Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
            .find((b) => b.textContent?.includes('Cancel'))!
            .click();
        expect(closed).toBe(1);
    });
});
