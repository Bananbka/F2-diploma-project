import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, signal } from '@angular/core';
import {
    ChevronRight,
    Ellipsis,
    Folder as FolderGlyph,
    Hash,
    Inbox,
    LucideAngularModule,
    LucideIconData,
    Mail,
    Pencil,
    Plus,
    SquarePen,
    Trash2,
    User,
    Users,
} from 'lucide-angular';

import { Chat } from '../../../core/models/chat.model';
import { Folder } from '../../../core/services/folder-api.service';
import { ContextMenuDirective, ContextMenuProvider } from '../../../shared/ui/context-menu/context-menu.directive';
import { ContextMenuEntry } from '../../../shared/ui/context-menu/context-menu.model';
import { ContextMenuService } from '../../../shared/ui/context-menu/context-menu.service';
import {
    chatsInFolder,
    ChatViewKey,
    folderKey,
    inSystemView,
    SYSTEM_VIEWS,
    SystemViewId,
    unreadTotal,
} from './chat-views';

export type NavSection = 'chats' | 'folders';

const COLLAPSED_KEY = 'chat-nav-collapsed';

const SYSTEM_ICONS: Record<SystemViewId, LucideIconData> = {
    all: Inbox,
    direct: User,
    group: Users,
    channel: Hash,
    unread: Mail,
};

interface NavItem {
    key: ChatViewKey;
    label: string;
    icon: LucideIconData;
    count: number;
    unread: number;
    folder: Folder | null;
}

export interface FolderEditRequest {
    folder: Folder;
    /** Which part of the editor the user asked for, so Rename lands on the name field. */
    focus: 'name' | 'chats';
}

/**
 * The chat list's navigation: collapsible sections of views, in the manner of an explorer sidebar.
 *
 * "Chats" holds the system views; "Folders" holds the user's own, with a header carrying the
 * create button and an overflow menu. Each section is a disclosure (a button with `aria-expanded`)
 * over a listbox of views, so the keyboard model is the two standard ones: Enter/Space on a header
 * folds it, arrows move inside a list, and Enter/Space on a view selects it. The collapsed state is
 * a UI preference and survives reloads.
 */
@Component({
    selector: 'app-chat-nav',
    imports: [LucideAngularModule, ContextMenuDirective],
    templateUrl: './chat-nav.component.html',
    styleUrl: './chat-nav.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatNavComponent {
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
    private readonly menus = inject(ContextMenuService);

    readonly chats = input.required<readonly Chat[]>();
    readonly folders = input.required<readonly Folder[]>();
    readonly selected = input.required<ChatViewKey>();

    readonly selectedChange = output<ChatViewKey>();
    readonly createFolder = output<void>();
    readonly editFolder = output<FolderEditRequest>();
    readonly deleteFolder = output<Folder>();

    readonly collapsed = signal<Record<NavSection, boolean>>(readCollapsed());

    readonly chevronIcon = ChevronRight;
    readonly plusIcon = Plus;
    readonly moreIcon = Ellipsis;

    readonly systemItems = computed<NavItem[]>(() =>
        SYSTEM_VIEWS.map((view) => {
            const inView = this.chats().filter((chat) => inSystemView(chat, view.id));
            return {
                key: view.id,
                label: view.label,
                icon: SYSTEM_ICONS[view.id],
                // "All chats" and "Unread" are not worth a count: one is the total, the other is its badge.
                count: view.id === 'unread' || view.id === 'all' ? 0 : inView.length,
                unread: view.id === 'unread' ? 0 : unreadTotal(inView),
                folder: null,
            };
        })
    );

    readonly folderItems = computed<NavItem[]>(() =>
        this.folders().map((folder) => {
            const inFolder = chatsInFolder(this.chats(), folder);
            return {
                key: folderKey(folder.id),
                label: folder.title,
                icon: FolderGlyph,
                count: inFolder.length,
                unread: unreadTotal(inFolder),
                folder,
            };
        })
    );

    /** What is selected inside a section, shown on its header while the section is folded away. */
    selectedLabel(section: NavSection): string | null {
        const items = section === 'chats' ? this.systemItems() : this.folderItems();
        const item = items.find((candidate) => candidate.key === this.selected());
        return item && this.isCollapsed(section) && !(section === 'chats' && item.key === 'all') ? item.label : null;
    }

    isCollapsed(section: NavSection): boolean {
        return this.collapsed()[section];
    }

    toggle(section: NavSection): void {
        this.collapsed.update((state) => ({ ...state, [section]: !state[section] }));
        try {
            localStorage.setItem(COLLAPSED_KEY, JSON.stringify(this.collapsed()));
        } catch {
            // Preference only.
        }
    }

    select(key: ChatViewKey): void {
        this.selectedChange.emit(key);
    }

    /** Exactly one option per list is a tab stop: the selected one, or the first when none is selected. */
    tabIndexFor(items: readonly NavItem[], item: NavItem): number {
        const hasSelection = items.some((candidate) => candidate.key === this.selected());
        return item.key === this.selected() || (!hasSelection && items[0] === item) ? 0 : -1;
    }

    /** Arrows, Home and End move between the views of one list; focus follows, selection does not. */
    onListKeydown(event: KeyboardEvent): void {
        const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
        if (!keys.includes(event.key)) {
            return;
        }
        const list = event.currentTarget as HTMLElement;
        const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
        const at = options.indexOf(document.activeElement as HTMLElement);
        if (options.length === 0 || at < 0) {
            return;
        }
        event.preventDefault();
        const next =
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : event.key === 'ArrowDown'
                    ? Math.min(options.length - 1, at + 1)
                    : Math.max(0, at - 1);
        options[next].focus();
    }

    folderMenu(folder: Folder): ContextMenuProvider {
        return (): ContextMenuEntry[] => [
            {
                icon: SquarePen,
                label: 'Edit chats in folder…',
                action: () => this.editFolder.emit({ folder, focus: 'chats' }),
            },
            { icon: Pencil, label: 'Rename…', action: () => this.editFolder.emit({ folder, focus: 'name' }) },
            { separator: true },
            { icon: Trash2, label: 'Delete folder', danger: true, action: () => this.deleteFolder.emit(folder) },
        ];
    }

    /** The "…" on the Folders header, opened under the button like a menu button rather than at the pointer. */
    openFoldersMenu(event: Event): void {
        const button = event.currentTarget as HTMLElement;
        const rect = button.getBoundingClientRect();
        const entries: ContextMenuEntry[] = [
            { icon: Plus, label: 'New folder…', action: () => this.createFolder.emit() },
            {
                label: this.isCollapsed('chats') ? 'Expand chat views' : 'Collapse chat views',
                action: () => this.toggle('chats'),
            },
            {
                label: 'Show all chats',
                disabled: this.selected() === 'all',
                action: () => this.select('all'),
            },
        ];
        this.menus.open(entries, { x: rect.right, y: rect.bottom + 4 }, { source: 'keyboard', trigger: button });
    }

    focusFirstOption(): void {
        this.host.nativeElement.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    }
}

function readCollapsed(): Record<NavSection, boolean> {
    const none = { chats: false, folders: false };
    try {
        const raw = localStorage.getItem(COLLAPSED_KEY);
        if (!raw) {
            return none;
        }
        const parsed = JSON.parse(raw) as Partial<Record<NavSection, unknown>>;
        return { chats: parsed.chats === true, folders: parsed.folders === true };
    } catch {
        return none;
    }
}
