import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { LucideAngularModule, Search, X } from 'lucide-angular';

import { Chat } from '../../../core/models/chat.model';
import { Folder } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { EmojiButtonComponent } from '../../../shared/ui/emoji-field/emoji-button.component';
import { trapTab } from '../../../shared/ui/focus-trap';
import { avatarKindFor, chatTitle } from '../../../shared/utils/display';
import { FOLDER_ICON_OPTIONS, FOLDER_ICONS } from '../folder-icons';

const MAX_TITLE = 64;

/**
 * Create a folder, or edit one: its name and which chats it holds.
 *
 * One dialog for both because the data is the same, and because the alternative (a name field in
 * one place and chat toggles scattered through context menus) is what made folders clumsy. The
 * chat set is saved as the complete list, since the API replaces membership wholesale.
 */
@Component({
    selector: 'app-folder-edit-dialog',
    imports: [LucideAngularModule, AvatarComponent, EmojiButtonComponent],
    templateUrl: './folder-edit-dialog.component.html',
    styleUrl: './folder-edit-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderEditDialogComponent {
    private readonly folders = inject(FolderStoreService);
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
    private readonly opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    /** The folder being edited, or null to create one. */
    readonly folder = input<Folder | null>(null);
    readonly chats = input.required<readonly Chat[]>();
    /** Where focus lands first. */
    readonly focus = input<'name' | 'chats'>('name');

    readonly closed = output<void>();

    private readonly nameField = viewChild.required<ElementRef<HTMLInputElement>>('nameField');
    private readonly searchField = viewChild.required<ElementRef<HTMLInputElement>>('searchField');

    readonly maxTitle = MAX_TITLE;
    readonly name = signal('');
    /** The chosen icon name, or null for the default. */
    readonly icon = signal<string | null>(null);
    readonly iconOptions = FOLDER_ICON_OPTIONS;
    readonly query = signal('');
    readonly picked = signal<ReadonlySet<string>>(new Set());
    /** What was in the folder when the dialog opened: chats float to the top by this, never by live ticks, so rows do not jump under the cursor. */
    private readonly initial = signal<ReadonlySet<string>>(new Set());
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);

    readonly closeIcon = X;
    readonly searchIcon = Search;
    readonly avatarKindFor = avatarKindFor;
    readonly chatTitle = chatTitle;

    readonly isEdit = computed(() => this.folder() !== null);

    readonly visible = computed(() => {
        const needle = this.query().trim().toLowerCase();
        return this.chats()
            .filter((chat) => !needle || chatTitle(chat).toLowerCase().includes(needle))
            .sort((a, b) => Number(this.initial().has(b.id)) - Number(this.initial().has(a.id)));
    });

    readonly canSave = computed(() => this.name().trim().length > 0 && !this.busy());

    constructor() {
        // `folder` is an input, so it is only readable once Angular has assigned it.
        afterNextRender(() => {
            const folder = this.folder();
            this.name.set(folder?.title ?? '');
            this.icon.set(folder?.icon && folder.icon in FOLDER_ICONS ? folder.icon : null);
            const ids = new Set(folder?.items.map((item) => item.chat_id) ?? []);
            this.initial.set(ids);
            this.picked.set(new Set(ids));
            (this.focus() === 'chats' && folder ? this.searchField() : this.nameField()).nativeElement.focus();
        });
    }

    toggle(chatId: string): void {
        this.picked.update((current) => {
            const next = new Set(current);
            if (!next.delete(chatId)) {
                next.add(chatId);
            }
            return next;
        });
    }

    /** Roving selection for the icon radiogroup: arrows move the choice and focus together. */
    onIconKeydown(event: KeyboardEvent): void {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (step === undefined) {
            return;
        }
        event.preventDefault();
        const index = this.iconOptions.findIndex((o) => o.name === this.icon());
        const next = this.iconOptions[(index + step + this.iconOptions.length) % this.iconOptions.length];
        this.icon.set(next.name);
        const group = (event.currentTarget as HTMLElement).parentElement;
        queueMicrotask(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
    }

    /** Escape closes this dialog only; it is handled here, on the dialog, so a menu or confirmation above it is untouched. */
    onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }
        trapTab(event, this.host.nativeElement);
    }

    private membershipChanged(): boolean {
        const before = this.initial();
        const after = this.picked();
        return before.size !== after.size || [...after].some((id) => !before.has(id));
    }

    async save(): Promise<void> {
        if (!this.canSave()) {
            return;
        }
        this.busy.set(true);
        this.error.set(null);

        const title = this.name().trim();
        const ids = [...this.picked()];
        const folder = this.folder();
        let ok: boolean;
        if (folder) {
            // Only what changed is sent: a rename must not rewrite the membership (the API replaces it).
            const changes: { title?: string; chatIds?: string[]; icon?: string | null } = {};
            if (title !== folder.title) {
                changes.title = title;
            }
            if (this.icon() !== (folder.icon ?? null)) {
                changes.icon = this.icon();
            }
            if (this.membershipChanged()) {
                changes.chatIds = ids;
            }
            ok = Object.keys(changes).length === 0 || (await this.folders.update(folder.id, changes));
        } else {
            ok = (await this.folders.create(title, ids, this.icon())) !== null;
        }

        this.busy.set(false);
        if (ok) {
            this.close();
        } else {
            // The dialog stays open with everything typed, so a failed save loses nothing.
            this.error.set(folder ? 'Could not save this folder.' : 'Could not create this folder.');
        }
    }

    close(): void {
        this.closed.emit();
        // Focus goes back to whatever opened the dialog, if it is still on the page.
        queueMicrotask(() => (this.opener?.isConnected ? this.opener.focus() : null));
    }
}
