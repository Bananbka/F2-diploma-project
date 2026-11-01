import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { Chat } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { FolderApiService } from '../../../core/services/folder-api.service';
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
