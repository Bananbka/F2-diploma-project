import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FolderPlus, Hash, Lock, LucideAngularModule, Plus, Search, ShieldOff, Users } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Chat, UserSearchResult } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { Folder, FolderApiService } from '../../../core/services/folder-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { chatListTime } from '../../../shared/utils/display';
import { ChatFilter } from '../navigation-rail/navigation-rail.component';

@Component({
    selector: 'app-chat-sidebar',
    imports: [LucideAngularModule, AvatarComponent],
    templateUrl: './chat-sidebar.component.html',
    styleUrl: './chat-sidebar.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSidebarComponent {
    private readonly store = inject(ChatStoreService);
    private readonly chatApi = inject(ChatApiService);
    private readonly directory = inject(DirectoryService);
    private readonly folderApi = inject(FolderApiService);
    private readonly toast = inject(ToastService);
    private readonly router = inject(Router);

    readonly filter = input.required<ChatFilter>();

    constructor() {
        void this.loadFolders();
    }

    readonly query = signal('');
    readonly menuOpen = signal(false);
    readonly folderEditorOpen = signal(false);
    readonly newFolderTitle = signal('');
    readonly people = signal<UserSearchResult[]>([]);
    readonly searching = signal(false);

    readonly chats = this.store.chats;
    readonly loading = this.store.chatsLoading;
    readonly error = this.store.chatsError;
    readonly activeChatId = this.store.activeChatId;

    readonly folders = signal<Folder[]>([]);
    readonly activeFolder = signal<string | null>(null);

    readonly visibleChats = computed(() => {
        const filter = this.filter();
        const needle = this.query().trim().toLowerCase();
        const folderId = this.activeFolder();
        const inFolder = folderId
            ? new Set(
                  this.folders()
                      .find((f) => f.id === folderId)
                      ?.items.map((i) => i.chat_id) ?? []
              )
            : null;

        return this.chats()
            .filter((chat) => filter === 'all' || chat.chat_type === filter)
            .filter((chat) => !inFolder || inFolder.has(chat.id))
            .filter((chat) => !needle || this.titleOf(chat).toLowerCase().includes(needle))
            .sort((a, b) => this.sortKey(b) - this.sortKey(a));
    });

    async loadFolders(): Promise<void> {
        try {
            this.folders.set(await firstValueFrom(this.folderApi.getFolders()));
        } catch {
            // Folders are an organisational convenience; the unfiltered list still works without them.
            this.folders.set([]);
        }
    }

    /**
     * Put the open chat in a folder, or take it out.
     *
     * The whole membership set is sent because `PATCH` replaces `chat_ids` outright rather than
     * merging — passing only the delta would silently empty the folder.
     */
    async toggleChatInFolder(folder: Folder, chatId: string): Promise<void> {
        const current = folder.items.map((item) => item.chat_id);
        const next = current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId];

        try {
            await firstValueFrom(this.folderApi.updateFolder(folder.id, { chat_ids: next }));
            await this.loadFolders();
        } catch {
            this.toast.error('Could not update that folder.');
        }
    }

    async createFolder(): Promise<void> {
        const title = this.newFolderTitle().trim();
        if (!title) {
            return;
        }

        try {
            await firstValueFrom(this.folderApi.createFolder(title, []));
            this.newFolderTitle.set('');
            this.folderEditorOpen.set(false);
            await this.loadFolders();
        } catch {
            // The input keeps its value, so the attempt is not lost.
            this.toast.error('Could not create that folder.');
        }
    }

    async deleteFolder(folder: Folder): Promise<void> {
        try {
            await firstValueFrom(this.folderApi.deleteFolder(folder.id));
            if (this.activeFolder() === folder.id) {
                this.activeFolder.set(null);
            }
            await this.loadFolders();
        } catch {
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

    readonly searchIcon = Search;
    readonly plusIcon = Plus;
    readonly usersIcon = Users;
    readonly hashIcon = Hash;
    readonly lockIcon = Lock;
    readonly shieldOffIcon = ShieldOff;
    readonly folderIcon = FolderPlus;

    isChatInFolder(folder: Folder, chatId: string): boolean {
        return folder.items.some((item) => item.chat_id === chatId);
    }

    openFolderEditor(): void {
        this.menuOpen.set(false);
        this.folderEditorOpen.set(true);
    }

    private searchTimer: ReturnType<typeof setTimeout> | null = null;

    titleOf(chat: Chat): string {
        return chat.title ?? (chat.chat_type === 'channel' ? 'Channel' : 'Untitled chat');
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
