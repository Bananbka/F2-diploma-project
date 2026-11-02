import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
    Hash,
    KeyRound,
    LogOut,
    LucideAngularModule,
    LucideIconData,
    Mail,
    MessageSquare,
    Pencil,
    Plus,
    Settings,
    Shield,
    SquarePen,
    Trash2,
    User,
    Users,
} from 'lucide-angular';

import { ChatStoreService } from '../../../core/services/chat-store.service';
import { Folder } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { SessionService } from '../../../core/services/session.service';
import { ToastService } from '../../../core/services/toast.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { BrandMarkComponent } from '../../../shared/ui/brand-mark/brand-mark.component';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { ContextMenuDirective, ContextMenuProvider } from '../../../shared/ui/context-menu/context-menu.directive';
import { ContextMenuEntry } from '../../../shared/ui/context-menu/context-menu.model';
import { SettingsService, SettingsTab } from '../../settings/settings.service';
import {
    chatsInFolder,
    ChatViewKey,
    folderKey,
    inSystemView,
    SYSTEM_VIEWS,
    SystemViewId,
    unreadTotal,
} from '../chat-views';
import { FolderEditDialogComponent } from '../folder-edit-dialog/folder-edit-dialog.component';

const SYSTEM_ICONS: Record<SystemViewId, LucideIconData> = {
    all: MessageSquare,
    unread: Mail,
    direct: User,
    group: Users,
    channel: Hash,
};

export interface RailItem {
    key: ChatViewKey;
    label: string;
    icon: LucideIconData | null;
    /** The folder's first letter, drawn in place of an icon. */
    initial: string | null;
    unread: number;
    folder: Folder | null;
}

/**
 * The activity bar: one button per view of the chat list (the system views, then one per user
 * folder, then "new folder"), with the account controls at the foot. Selecting a button filters
 * the sidebar's list; the shell owns the selection.
 */
@Component({
    selector: 'app-navigation-rail',
    imports: [
        LucideAngularModule,
        AvatarComponent,
        BrandMarkComponent,
        ContextMenuDirective,
        FolderEditDialogComponent,
    ],
    templateUrl: './navigation-rail.component.html',
    styleUrl: './navigation-rail.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NavigationRailComponent {
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly settings = inject(SettingsService);
    private readonly chatStore = inject(ChatStoreService);
    private readonly folderStore = inject(FolderStoreService);
    private readonly confirm = inject(ConfirmService);
    private readonly toast = inject(ToastService);

    /** The selected view: a system view or `folder:<id>`. */
    readonly view = input.required<ChatViewKey>();
    readonly viewChange = output<ChatViewKey>();
    /** Emitted by the shield: opens the safety number for whoever is on screen. */
    readonly securityRequested = output<void>();

    readonly menuOpen = signal(false);

    readonly user = this.session.user;
    readonly chats = this.chatStore.chats;

    /** The folder dialog: closed, creating, or editing one (and which part to land on). */
    readonly folderDialog = signal<{ folder: Folder | null; focus: 'name' | 'chats' } | null>(null);

    readonly systemItems = computed<RailItem[]>(() =>
        SYSTEM_VIEWS.map((view) => ({
            key: view.id,
            label: view.label,
            icon: SYSTEM_ICONS[view.id],
            initial: null,
            // "All chats" would only repeat the total of the others, so it carries no badge.
            unread: view.id === 'all' ? 0 : unreadTotal(this.chats().filter((c) => inSystemView(c, view.id))),
            folder: null,
        }))
    );

    readonly folderItems = computed<RailItem[]>(() =>
        this.folderStore.folders().map((folder) => ({
            key: folderKey(folder.id),
            label: folder.title,
            icon: null,
            initial: (Array.from(folder.title.trim())[0] ?? '?').toUpperCase(),
            unread: unreadTotal(chatsInFolder(this.chats(), folder)),
            folder,
        }))
    );

    readonly plusIcon = Plus;
    readonly shieldIcon = Shield;
    readonly settingsIcon = Settings;
    readonly logOutIcon = LogOut;
    readonly userIcon = User;
    readonly keyIcon = KeyRound;

    constructor() {
        void this.folderStore.load();
    }

    select(key: ChatViewKey): void {
        this.viewChange.emit(key);
    }

    /** The name a screen reader needs, since the button itself is only a glyph. */
    labelFor(item: RailItem): string {
        return item.unread > 0 ? `${item.label}, ${item.unread} unread` : item.label;
    }

    badgeText(count: number): string {
        return count > 99 ? '99+' : String(count);
    }

    openFolderDialog(request?: { folder: Folder; focus: 'name' | 'chats' }): void {
        this.folderDialog.set({ folder: request?.folder ?? null, focus: request?.focus ?? 'name' });
    }

    folderMenu(folder: Folder): ContextMenuProvider {
        return (): ContextMenuEntry[] => [
            {
                icon: SquarePen,
                label: 'Edit chats in folder…',
                action: () => this.openFolderDialog({ folder, focus: 'chats' }),
            },
            { icon: Pencil, label: 'Rename…', action: () => this.openFolderDialog({ folder, focus: 'name' }) },
            { separator: true },
            { icon: Trash2, label: 'Delete folder', danger: true, action: () => void this.confirmDeleteFolder(folder) },
        ];
    }

    /** A deleted folder that was selected falls back to "All chats" in the shell. */
    async confirmDeleteFolder(folder: Folder): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Delete folder?',
            message: `The folder “${folder.title}” is removed. The chats in it are not affected.`,
            confirmLabel: 'Delete folder',
            danger: true,
        });
        if (confirmed && !(await this.folderStore.remove(folder))) {
            this.toast.error('Could not delete that folder.');
        }
    }

    /**
     * Open the settings dialog. The opener is passed in because a click inside the account menu
     * closes the menu, which removes the very button focus would otherwise return to.
     */
    openSettings(tab: SettingsTab, opener: Event | HTMLElement): void {
        this.menuOpen.set(false);
        const element = opener instanceof Event ? (opener.currentTarget as HTMLElement) : opener;
        this.settings.open(tab, element);
    }

    async signOut(): Promise<void> {
        this.menuOpen.set(false);
        await this.session.logout();
        await this.router.navigate(['/login']);
    }
}
