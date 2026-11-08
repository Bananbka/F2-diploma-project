import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
    EyeOff,
    FolderCog,
    KeyRound,
    LogOut,
    LucideAngularModule,
    LucideIconData,
    Pencil,
    Plus,
    Settings,
    Shield,
    SquarePen,
    Trash2,
    User,
} from 'lucide-angular';

import { HiddenViewId } from '../../../core/models/appearance.model';
import { AppearanceStore } from '../../../core/services/appearance-store.service';
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
import { chatsInFolder, ChatViewKey, folderKey, inSystemView, unreadTotal } from '../chat-views';
import { canHideView, DEFAULT_VIEWS, DefaultView } from '../default-views';
import { FolderEditDialogComponent } from '../folder-edit-dialog/folder-edit-dialog.component';
import { folderIconFor } from '../folder-icons';

export interface RailItem {
    key: ChatViewKey;
    label: string;
    icon: LucideIconData | null;
    unread: number;
    folder: Folder | null;
    /** The built-in view this is, so it can be hidden; absent for a folder. */
    viewId?: HiddenViewId;
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
    private readonly appearance = inject(AppearanceStore);

    /** The selected view: a system view or `folder:<id>`. */
    readonly view = input.required<ChatViewKey>();
    readonly viewChange = output<ChatViewKey>();
    /** Emitted by the shield: opens the safety number for whoever is on screen. */
    readonly securityRequested = output<void>();
    /** True while the Contacts view replaces the chat list; no chat view is then the current one. */
    readonly contactsActive = input(false);
    readonly contactsRequested = output<void>();
    readonly contactsView = DEFAULT_VIEWS.find((v) => v.id === 'contacts')!;
    readonly contactsIcon = this.contactsView.icon;
    readonly hidden = computed(() => this.appearance.value().hidden_views);
    readonly contactsHidden = computed(() => this.hidden().includes('contacts'));

    readonly menuOpen = signal(false);

    readonly user = this.session.user;
    readonly chats = this.chatStore.chats;

    /** The folder dialog: closed, creating, or editing one (and which part to land on). */
    readonly folderDialog = signal<{ folder: Folder | null; focus: 'name' | 'chats' } | null>(null);

    /** The built-in chat views the user has not hidden. */
    readonly systemItems = computed<RailItem[]>(() =>
        DEFAULT_VIEWS.filter((view) => view.chatView && !this.hidden().includes(view.id)).map((view) => ({
            key: view.chatView!,
            viewId: view.id,
            label: view.label,
            icon: view.icon,
            // "All chats" would only repeat the total of the others, so it carries no badge.
            unread:
                view.chatView === 'all' ? 0 : unreadTotal(this.chats().filter((c) => inSystemView(c, view.chatView!))),
            folder: null,
        }))
    );

    readonly folderItems = computed<RailItem[]>(() =>
        this.folderStore.folders().map((folder) => ({
            key: folderKey(folder.id),
            label: folder.title,
            icon: folderIconFor(folder.icon),
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

    /** Right-click, long-press or the menu key on a built-in view. */
    defaultViewMenu(view: Pick<DefaultView, 'id'>): ContextMenuProvider {
        return (): ContextMenuEntry[] => {
            const allowed = canHideView(this.hidden(), view.id);
            return [
                {
                    icon: EyeOff,
                    label: 'Hide from sidebar',
                    disabled: !allowed,
                    disabledReason: allowed ? undefined : 'At least one chat view must stay visible.',
                    action: () => this.hideView(view.id),
                },
                { separator: true },
                { icon: FolderCog, label: 'Manage folders…', action: () => this.manageFolders() },
            ];
        };
    }

    hideView(id: HiddenViewId): void {
        if (!canHideView(this.hidden(), id) || this.hidden().includes(id)) {
            return;
        }
        this.appearance.update({ hidden_views: [...this.hidden(), id] });
    }

    manageFolders(): void {
        this.menuOpen.set(false);
        this.settings.open('folders');
    }

    folderMenu(folder: Folder): ContextMenuProvider {
        return (): ContextMenuEntry[] => [
            {
                icon: SquarePen,
                label: 'Edit chats in folder…',
                action: () => this.openFolderDialog({ folder, focus: 'chats' }),
            },
            { icon: Pencil, label: 'Rename…', action: () => this.openFolderDialog({ folder, focus: 'name' }) },
            { icon: FolderCog, label: 'Manage folders…', action: () => this.manageFolders() },
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
