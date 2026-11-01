import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import {
    BellOff,
    FolderPlus,
    Hash,
    Lock,
    LucideAngularModule,
    Pin,
    Plus,
    Search,
    ShieldOff,
    Users,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Chat, UserSearchResult } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { Folder } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { ToastService } from '../../../core/services/toast.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { ContextMenuDirective, ContextMenuProvider } from '../../../shared/ui/context-menu/context-menu.directive';
import { avatarKindFor, chatListTime, chatTitle } from '../../../shared/utils/display';
import { ChatNavComponent, FolderEditRequest } from '../chat-nav/chat-nav.component';
import { chatsInView, ChatViewKey, isFolderKey } from '../chat-nav/chat-views';
import { FolderEditDialogComponent } from '../folder-edit-dialog/folder-edit-dialog.component';
import { ChatFilter } from '../navigation-rail/navigation-rail.component';
import { buildChatMenu } from './chat-menu';

@Component({
    selector: 'app-chat-sidebar',
    imports: [LucideAngularModule, AvatarComponent, ContextMenuDirective, ChatNavComponent, FolderEditDialogComponent],
    templateUrl: './chat-sidebar.component.html',
    styleUrl: './chat-sidebar.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSidebarComponent {
    private readonly store = inject(ChatStoreService);
    private readonly chatApi = inject(ChatApiService);
    private readonly directory = inject(DirectoryService);
    private readonly folderStore = inject(FolderStoreService);
    private readonly toast = inject(ToastService);
    private readonly router = inject(Router);
    private readonly confirm = inject(ConfirmService);

    readonly filter = input.required<ChatFilter>();
    /** Bumped on every rail click, so choosing the filter that is already current still resets the view. */
    readonly filterVersion = input(0);

    constructor() {
        void this.folderStore.load();

        // The rail's Chats / Groups / Channels still pick a view; after that the nav owns it.
        effect(() => {
            const filter = this.filter();
            this.filterVersion();
            untracked(() => this.view.set(filter));
        });

        // A selected folder that is gone (deleted elsewhere) must not leave the list filtered by
        // nothing while the nav shows no selection: fall back to everything, in both places.
        effect(() => {
            const view = this.view();
            if (
                isFolderKey(view) &&
                this.folderStore.loaded() &&
                !this.folders().some((f) => `folder:${f.id}` === view)
            ) {
                untracked(() => this.view.set('all'));
            }
        });
    }

    readonly query = signal('');
    readonly menuOpen = signal(false);
    /** The folder dialog: closed, creating, or editing one (and which part to land on). */
    readonly folderDialog = signal<{ folder: Folder | null; focus: 'name' | 'chats' } | null>(null);
    readonly people = signal<UserSearchResult[]>([]);
    readonly searching = signal(false);

    readonly chats = this.store.chats;
    readonly loading = this.store.chatsLoading;
    readonly error = this.store.chatsError;
    readonly activeChatId = this.store.activeChatId;

    readonly folders = this.folderStore.folders;
    /** The selected view: a system view or one of the user's folders. */
    readonly view = signal<ChatViewKey>('all');

    readonly visibleChats = computed(() => {
        const needle = this.query().trim().toLowerCase();

        return chatsInView(this.chats(), this.view(), this.folders())
            .filter((chat) => !needle || this.titleOf(chat).toLowerCase().includes(needle))
            .sort((a, b) => this.pinKey(b) - this.pinKey(a) || this.sortKey(b) - this.sortKey(a));
    });

    /** Pinned rows come first, the most recent pin on top; the server orders its list the same way. */
    private pinKey(chat: Chat): number {
        if (!chat.is_pinned) {
            return 0;
        }
        const parsed = chat.pinned_at ? new Date(chat.pinned_at).getTime() : NaN;
        return Number.isNaN(parsed) ? 1 : parsed;
    }

    selectView(key: ChatViewKey): void {
        this.view.set(key);
    }

    /** Put the chat in a folder, or take it out (the row menu's "Add to folder"). */
    async toggleChatInFolder(folder: Folder, chatId: string): Promise<void> {
        if (!(await this.folderStore.toggleChat(folder.id, chatId))) {
            this.toast.error('Could not update that folder.');
        }
    }

    openFolderDialog(request?: FolderEditRequest): void {
        this.menuOpen.set(false);
        this.folderDialog.set({ folder: request?.folder ?? null, focus: request?.focus ?? 'name' });
    }

    async confirmDeleteFolder(folder: Folder): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Delete folder?',
            message: `The folder “${folder.title}” is removed. The chats in it are not affected.`,
            confirmLabel: 'Delete folder',
            danger: true,
        });
        if (!confirmed) {
            return;
        }
        if (await this.folderStore.remove(folder)) {
            if (this.view() === `folder:${folder.id}`) {
                this.view.set('all');
            }
        } else {
            this.toast.error('Could not delete that folder.');
        }
    }

    /** People we could start a chat with, minus anyone we already have a private chat with. */
    readonly newContacts = computed(() => {
        const existing = new Set(
            this.chats()
                .filter((chat) => chat.chat_type === 'private')
                .map((chat) => this.titleOf(chat).toLowerCase())
        );
        return this.people().filter((person) => !existing.has(person.full_name.toLowerCase()));
    });

    readonly avatarKindFor = avatarKindFor;
    readonly searchIcon = Search;
    readonly plusIcon = Plus;
    readonly usersIcon = Users;
    readonly hashIcon = Hash;
    readonly lockIcon = Lock;
    readonly shieldOffIcon = ShieldOff;
    readonly folderIcon = FolderPlus;
    readonly bellOffIcon = BellOff;
    readonly pinIcon = Pin;

    private searchTimer: ReturnType<typeof setTimeout> | null = null;

    titleOf(chat: Chat): string {
        return chatTitle(chat);
    }

    preview(chat: Chat) {
        return this.store.preview(chat);
    }

    timeOf(chat: Chat): string {
        return chatListTime(chat.last_message?.created_at ?? chat.updated_at ?? chat.created_at);
    }

    onQuery(value: string): void {
        this.query.set(value);

        if (this.searchTimer) {
            clearTimeout(this.searchTimer);
        }

        if (value.trim().length < 2) {
            this.people.set([]);
            return;
        }

        // Debounced so typing does not fan out a request per keystroke.
        this.searchTimer = setTimeout(() => void this.searchPeople(value.trim()), 250);
    }

    private async searchPeople(query: string): Promise<void> {
        this.searching.set(true);
        try {
            this.people.set(await this.directory.search(query));
        } catch {
            this.people.set([]);
        } finally {
            this.searching.set(false);
        }
    }

    /** The right-click / long-press / Menu-key menu of one row. */
    chatMenu(chat: Chat): ContextMenuProvider {
        return () =>
            buildChatMenu({
                chat,
                folders: this.folders(),
                role: chat.my_role ?? null,
                isActive: this.activeChatId() === chat.id,
                actions: {
                    pin: (target, pinned) => void this.store.setPinned(target.id, pinned),
                    markUnread: (target, marked) => void this.store.setMarkedUnread(target.id, marked),
                    mute: (target, until) => void this.mute(target, until),
                    toggleFolder: (folder, target) => void this.toggleChatInFolder(folder, target.id),
                    clearHistory: (target) => void this.clearHistory(target),
                    leave: (target) => void this.leave(target),
                    remove: (target) => void this.remove(target),
                },
            });
    }

    private async mute(chat: Chat, until: string | null): Promise<void> {
        if (!(await this.store.setMuted(chat.id, until))) {
            this.toast.error('Could not update notifications for that chat.');
        }
    }

    private async clearHistory(chat: Chat): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Clear history?',
            message: `This clears the conversation for you only. Everyone else in ${this.titleOf(chat)} keeps their copy, and new messages will still arrive.`,
            confirmLabel: 'Clear history',
            danger: true,
        });
        if (confirmed) {
            await this.store.clearHistory(chat.id);
        }
    }

    private async leave(chat: Chat): Promise<void> {
        const noun = chat.chat_type === 'channel' ? 'channel' : 'group';
        const confirmed = await this.confirm.ask({
            title: `Leave ${noun}?`,
            message:
                chat.chat_type === 'channel'
                    ? `You will stop receiving posts from ${this.titleOf(chat)}. You cannot rejoin without being added again.`
                    : `You will stop receiving messages from ${this.titleOf(chat)}. The group rotates its keys when you go, and you cannot rejoin without being added again.`,
            confirmLabel: `Leave ${noun}`,
            danger: true,
        });
        if (confirmed) {
            await this.store.leaveChat(chat.id);
        }
    }

    private async remove(chat: Chat): Promise<void> {
        const noun = chat.chat_type === 'channel' ? 'channel' : 'group';
        const confirmed = await this.confirm.ask({
            title: `Delete ${noun}?`,
            message: `${this.titleOf(chat)} and every message in it are deleted for all members. This cannot be undone.`,
            confirmLabel: `Delete ${noun}`,
            danger: true,
        });
        if (!confirmed) {
            return;
        }
        // Irreversible and it affects everyone, so one click is not enough.
        const sure = await this.confirm.ask({
            title: `Delete ${this.titleOf(chat)} for everyone?`,
            message: 'Every member loses the chat and all of its messages and attachments. There is no undo.',
            confirmLabel: 'Delete forever',
            danger: true,
        });
        if (sure) {
            await this.store.deleteChat(chat.id);
        }
    }

    async openChat(chatId: string): Promise<void> {
        await this.router.navigate(['/chats', chatId]);
    }

    async startPrivateChat(person: UserSearchResult): Promise<void> {
        const chat = await firstValueFrom(this.chatApi.createPrivateChat(person.id));
        this.query.set('');
        this.people.set([]);
        await this.store.loadChats();
        await this.openChat(chat.id);
    }

    async goTo(path: string[]): Promise<void> {
        this.menuOpen.set(false);
        await this.router.navigate(path);
    }

    private sortKey(chat: Chat): number {
        const stamp = chat.last_message?.created_at ?? chat.updated_at ?? chat.created_at;
        const parsed = new Date(stamp).getTime();
        return Number.isNaN(parsed) ? 0 : parsed;
    }
}
