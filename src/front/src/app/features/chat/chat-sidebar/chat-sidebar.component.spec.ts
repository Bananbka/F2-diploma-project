import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { Chat } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { Folder, FolderApiService } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { ContextMenuItem } from '../../../shared/ui/context-menu/context-menu.model';
import { ChatSidebarComponent } from './chat-sidebar.component';

function chat(overrides: Partial<Chat>): Chat {
    return {
        id: 'c1',
        chat_type: 'group',
        title: 'Team',
        avatar_url: null,
        unread_count: 0,
        last_message: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
        participants: [],
        muted_until: null,
        is_muted: false,
        ...overrides,
    };
}

describe('ChatSidebarComponent menus', () => {
    let store: jasmine.SpyObj<ChatStoreService> & { chats: unknown };
    let confirm: jasmine.SpyObj<ConfirmService>;

    function menuItem(target: Chat, label: string): ContextMenuItem | undefined {
        const fixture = TestBed.createComponent(ChatSidebarComponent);
        fixture.componentRef.setInput('filter', 'all');
        const entries = fixture.componentInstance.chatMenu(target)();
        return entries.find((e): e is ContextMenuItem => 'label' in e && e.label === label);
    }

    beforeEach(() => {
        store = Object.assign(
            jasmine.createSpyObj('ChatStoreService', ['deleteChat', 'leaveChat', 'clearHistory', 'preview']),
            {
                chats: signal<Chat[]>([]),
                chatsLoading: signal(false),
                chatsError: signal(null),
                activeChatId: signal<string | null>(null),
            }
        );
        confirm = jasmine.createSpyObj<ConfirmService>('ConfirmService', ['ask']);

        TestBed.configureTestingModule({
            providers: [
                provideRouter([]),
                { provide: ChatStoreService, useValue: store },
                { provide: ConfirmService, useValue: confirm },
                { provide: ChatApiService, useValue: {} },
                { provide: DirectoryService, useValue: { search: async () => [] } },
                { provide: FolderApiService, useValue: { getFolders: () => of([]) } },
            ],
        });
    });

    it('asks twice before deleting a chat for everyone', async () => {
        confirm.ask.and.resolveTo(true);

        menuItem(chat({ my_role: 'owner' }), 'Delete group')!.action!();
        await new Promise((resolve) => setTimeout(resolve));

        expect(confirm.ask).toHaveBeenCalledTimes(2);
        expect(store.deleteChat).toHaveBeenCalledWith('c1');
    });

    it('stops after the first refusal', async () => {
        confirm.ask.and.resolveTo(false);

        menuItem(chat({ my_role: 'owner' }), 'Delete group')!.action!();
        await new Promise((resolve) => setTimeout(resolve));

        expect(confirm.ask).toHaveBeenCalledTimes(1);
        expect(store.deleteChat).not.toHaveBeenCalled();
    });

    it('leaves a channel without claiming a key rotation', async () => {
        confirm.ask.and.resolveTo(true);

        menuItem(chat({ chat_type: 'channel', my_role: 'member' }), 'Leave channel')!.action!();
        await new Promise((resolve) => setTimeout(resolve));

        expect(confirm.ask.calls.mostRecent().args[0].message).not.toContain('rotates');
        expect(store.leaveChat).toHaveBeenCalledWith('c1');
    });

    it('offers neither leave nor delete when the role is unknown', () => {
        expect(menuItem(chat({}), 'Leave group')).toBeUndefined();
        expect(menuItem(chat({}), 'Delete group')).toBeUndefined();
    });
});

describe('ChatSidebarComponent views', () => {
    const chats = signal<Chat[]>([]);

    function render(filter: 'all' | 'group' | 'channel' = 'all', folders: Folder[] = []) {
        const store = Object.assign(jasmine.createSpyObj('ChatStoreService', ['preview', 'loadChats']), {
            chats,
            chatsLoading: signal(false),
            chatsError: signal(null),
            activeChatId: signal<string | null>(null),
        });
        store.preview.and.returnValue({ text: '', readable: true });
        TestBed.configureTestingModule({
            providers: [
                provideRouter([]),
                { provide: ChatStoreService, useValue: store },
                { provide: ChatApiService, useValue: {} },
                { provide: DirectoryService, useValue: { search: async () => [] } },
                { provide: FolderApiService, useValue: { getFolders: () => of(folders) } },
            ],
        });
        const fixture = TestBed.createComponent(ChatSidebarComponent);
        fixture.componentRef.setInput('filter', filter);
        fixture.detectChanges();
        return fixture;
    }

    const titles = (fixture: ReturnType<typeof render>) =>
        Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.row .title')).map((t) =>
            t.textContent?.trim()
        );

    beforeEach(() => {
        localStorage.removeItem('chat-nav-collapsed');
        chats.set([
            chat({ id: 'dm', chat_type: 'private', title: 'Bob', unread_count: 2 }),
            chat({ id: 'g1', title: 'Team' }),
            chat({ id: 'ch', chat_type: 'channel', title: 'News' }),
        ]);
    });

    it('replaces the pill row with the nav sections', async () => {
        const fixture = render('all', [{ id: 'f1', title: 'Work', items: [{ chat_id: 'g1' }] }]);
        await fixture.whenStable();
        fixture.detectChanges();
        const host = fixture.nativeElement as HTMLElement;

        expect(host.querySelector('app-chat-nav')).not.toBeNull();
        expect(host.querySelector('.folders')).toBeNull();
        expect(host.querySelector('.folder-tab')).toBeNull();
    });

    it('filters the list by the selected folder and by system views', async () => {
        const fixture = render('all', [{ id: 'f1', title: 'Work', items: [{ chat_id: 'g1' }] }]);
        await fixture.whenStable();

        fixture.componentInstance.selectView('folder:f1');
        fixture.detectChanges();
        expect(titles(fixture)).toEqual(['Team']);

        fixture.componentInstance.selectView('direct');
        fixture.detectChanges();
        expect(titles(fixture)).toEqual(['Bob']);

        fixture.componentInstance.selectView('unread');
        fixture.detectChanges();
        expect(titles(fixture)).toEqual(['Bob']);

        fixture.componentInstance.selectView('channel');
        fixture.detectChanges();
        expect(titles(fixture)).toEqual(['News']);
    });

    it('follows the rail filter', () => {
        const fixture = render('group');
        expect(titles(fixture)).toEqual(['Team']);
        fixture.componentRef.setInput('filter', 'channel');
        fixture.detectChanges();
        expect(titles(fixture)).toEqual(['News']);
    });

    it('falls back to all chats when the selected folder disappears', async () => {
        const fixture = render('all', [{ id: 'f1', title: 'Work', items: [{ chat_id: 'g1' }] }]);
        await fixture.whenStable();
        fixture.componentInstance.selectView('folder:f1');
        fixture.detectChanges();
        expect(titles(fixture)).toEqual(['Team']);

        TestBed.inject(FolderStoreService).folders.set([]);
        fixture.detectChanges();

        expect(fixture.componentInstance.view()).toBe('all');
        expect(titles(fixture).length).toBe(3);
    });

    it('resets to all chats when the rail filter is clicked again while a folder is selected', async () => {
        const fixture = render('all', [{ id: 'f1', title: 'Work', items: [{ chat_id: 'g1' }] }]);
        await fixture.whenStable();
        fixture.componentInstance.selectView('folder:f1');
        fixture.detectChanges();

        fixture.componentRef.setInput('filterVersion', 1);
        fixture.detectChanges();

        expect(fixture.componentInstance.view()).toBe('all');
    });

    it('opens the folder dialog from the nav and closes it again', async () => {
        const fixture = render();
        await fixture.whenStable();
        const host = fixture.nativeElement as HTMLElement;

        host.querySelector<HTMLButtonElement>('button[aria-label="New folder"]')!.click();
        fixture.detectChanges();
        expect(host.querySelector('app-folder-edit-dialog')).not.toBeNull();

        fixture.componentInstance.folderDialog.set(null);
        fixture.detectChanges();
        expect(host.querySelector('app-folder-edit-dialog')).toBeNull();
    });

    it('draws a group without a picture as a lettered circle, like a person', () => {
        const fixture = render();
        const host = fixture.nativeElement as HTMLElement;
        const faces = Array.from(host.querySelectorAll('.row app-avatar .monogram')).map((f) => f.textContent?.trim());
        expect(faces).toContain('T');
        expect(faces).toContain('BO');
        expect(host.querySelector('.row app-avatar lucide-icon')).toBeNull();
    });
});
