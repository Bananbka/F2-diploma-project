import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { Chat } from '../../../core/models/chat.model';
import { Folder } from '../../../core/services/folder-api.service';
import { ContextMenuItem } from '../../../shared/ui/context-menu/context-menu.model';
import { ContextMenuService } from '../../../shared/ui/context-menu/context-menu.service';
import { ChatNavComponent } from './chat-nav.component';
import { chatsInView, ChatViewKey, inSystemView, unreadTotal } from './chat-views';

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
    return {
        id,
        chat_type: 'group',
        title: id,
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

const CHATS = [
    chat('dm', { chat_type: 'private', unread_count: 3 }),
    chat('team', { chat_type: 'group' }),
    chat('news', { chat_type: 'channel', marked_unread: true }),
];

const WORK: Folder = { id: 'f1', title: 'Work', items: [{ chat_id: 'team' }, { chat_id: 'news' }] };
const EMPTY: Folder = { id: 'f2', title: 'Empty', items: [] };

describe('chat views', () => {
    it('filters by kind and by unread', () => {
        expect(CHATS.filter((c) => inSystemView(c, 'direct')).map((c) => c.id)).toEqual(['dm']);
        expect(CHATS.filter((c) => inSystemView(c, 'group')).map((c) => c.id)).toEqual(['team']);
        expect(CHATS.filter((c) => inSystemView(c, 'channel')).map((c) => c.id)).toEqual(['news']);
        expect(CHATS.filter((c) => inSystemView(c, 'unread')).map((c) => c.id)).toEqual(['dm', 'news']);
    });

    it('counts a hand-flagged chat as one unread', () => {
        expect(unreadTotal(CHATS)).toBe(4);
    });

    it('resolves a folder view to its members, and an unknown folder to everything', () => {
        expect(chatsInView(CHATS, 'folder:f1', [WORK]).map((c) => c.id)).toEqual(['team', 'news']);
        expect(chatsInView(CHATS, 'folder:gone', [WORK])).toEqual([]);
    });
});

describe('ChatNavComponent', () => {
    let fixture: ComponentFixture<ChatNavComponent>;
    let host: HTMLElement;

    function render(selected: ChatViewKey = 'all', folders: Folder[] = [WORK, EMPTY]): void {
        fixture = TestBed.createComponent(ChatNavComponent);
        fixture.componentRef.setInput('chats', CHATS);
        fixture.componentRef.setInput('folders', folders);
        fixture.componentRef.setInput('selected', selected);
        fixture.detectChanges();
        host = fixture.nativeElement as HTMLElement;
    }

    const options = (list: string) =>
        Array.from(host.querySelectorAll<HTMLElement>(`#chat-nav-list-${list} [role="option"]`));

    beforeEach(() => {
        localStorage.removeItem('chat-nav-collapsed');
        TestBed.configureTestingModule({ providers: [provideRouter([])] });
    });

    afterEach(() => localStorage.removeItem('chat-nav-collapsed'));

    it('lists the system views and the folders in two sections, with no row of pills', () => {
        render();

        expect(options('chats').map((o) => o.querySelector('.item-label')?.textContent?.trim())).toEqual([
            'All chats',
            'Direct',
            'Groups',
            'Channels',
            'Unread',
        ]);
        expect(options('folders').map((o) => o.querySelector('.item-label')?.textContent?.trim())).toEqual([
            'Work',
            'Empty',
        ]);
        expect(host.querySelector('[role="tablist"]')).toBeNull();
    });

    it('shows a chat count and an unread badge on a folder', () => {
        render();
        const work = options('folders')[0];

        expect(work.querySelector('.item-count')?.textContent?.trim()).toBe('2');
        expect(work.querySelector('.item-unread')?.textContent?.trim()).toBe('1');
        expect(options('folders')[1].querySelector('.item-unread')).toBeNull();
    });

    it('marks the selected view and emits a selection', () => {
        render('folder:f1');
        const emitted: ChatViewKey[] = [];
        fixture.componentInstance.selectedChange.subscribe((key) => emitted.push(key));

        expect(options('folders')[0].getAttribute('aria-selected')).toBe('true');
        expect(options('chats')[0].getAttribute('aria-selected')).toBe('false');

        options('chats')[2].click();
        expect(emitted).toEqual(['group']);
    });

    it('keeps exactly one tab stop per list', () => {
        render('folder:f2');
        expect(options('folders').map((o) => o.getAttribute('tabindex'))).toEqual(['-1', '0']);
        // Nothing selected in this list: the first option is the stop.
        expect(options('chats').map((o) => o.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
    });

    it('moves focus with the arrow keys, Home and End without selecting', () => {
        render();
        const list = options('chats');
        list[0].focus();

        list[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(list[1]);
        list[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(document.activeElement).toBe(list[4]);
        list[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement).toBe(list[0]);
        expect(options('chats')[0].getAttribute('aria-selected')).toBe('true');
    });

    it('folds a section with its header, announces it, and remembers it', () => {
        render();
        const toggle = host.querySelector<HTMLButtonElement>('#chat-nav-toggle-folders')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('true');

        toggle.click();
        fixture.detectChanges();

        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector<HTMLElement>('#chat-nav-list-folders')!.hidden).toBeTrue();
        expect(JSON.parse(localStorage.getItem('chat-nav-collapsed')!)).toEqual({ chats: false, folders: true });

        render();
        expect(host.querySelector('#chat-nav-toggle-folders')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('names the selection on a folded header', () => {
        render('folder:f1');
        const toggle = host.querySelector<HTMLButtonElement>('#chat-nav-toggle-folders')!;
        expect(toggle.querySelector('.section-selected')).toBeNull();

        toggle.click();
        fixture.detectChanges();
        expect(toggle.querySelector('.section-selected')?.textContent?.trim()).toBe('Work');
        // Nothing to say for the default view of the other section.
        expect(host.querySelector('#chat-nav-toggle-chats .section-selected')).toBeNull();
    });

    it('survives unreadable stored state', () => {
        localStorage.setItem('chat-nav-collapsed', '{nope');
        render();
        expect(host.querySelector('#chat-nav-toggle-chats')?.getAttribute('aria-expanded')).toBe('true');
    });

    it('creates a folder from the header plus button and from the empty hint', () => {
        render('all', []);
        let created = 0;
        fixture.componentInstance.createFolder.subscribe(() => created++);

        host.querySelector<HTMLButtonElement>('button[aria-label="New folder"]')!.click();
        host.querySelector<HTMLButtonElement>('.hint-action')!.click();

        expect(created).toBe(2);
    });

    it('offers edit, rename and delete on a folder context menu', () => {
        render();
        const menu = fixture.componentInstance.folderMenu(WORK)() as ContextMenuItem[];
        const labels = menu.filter((e): e is ContextMenuItem => 'label' in e).map((e) => e.label);
        expect(labels).toEqual(['Edit chats in folder…', 'Rename…', 'Delete folder']);

        const edits: string[] = [];
        let deleted: Folder | null = null;
        fixture.componentInstance.editFolder.subscribe((r) => edits.push(r.focus));
        fixture.componentInstance.deleteFolder.subscribe((f) => (deleted = f));
        (menu[0] as ContextMenuItem).action!();
        (menu[1] as ContextMenuItem).action!();
        (menu[3] as ContextMenuItem).action!();

        expect(edits).toEqual(['chats', 'name']);
        expect(deleted as Folder | null).toBe(WORK);
    });

    it('opens the overflow menu from the Folders header', () => {
        render();
        const open = spyOn(TestBed.inject(ContextMenuService), 'open').and.returnValue(true);

        host.querySelector<HTMLButtonElement>('button[aria-label="Folder options"]')!.click();

        const entries = open.calls.mostRecent().args[0] as ContextMenuItem[];
        expect(entries.map((e) => e.label)).toContain('New folder…');
    });
});
