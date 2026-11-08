import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideAngularModule, Pencil, Plus, RotateCcw, SquarePen, Trash2 } from 'lucide-angular';

import { HiddenViewId } from '../../../core/models/appearance.model';
import { AppearanceStore } from '../../../core/services/appearance-store.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { Folder } from '../../../core/services/folder-api.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { ToastService } from '../../../core/services/toast.service';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { canHideView, DEFAULT_VIEWS } from '../../chat/default-views';
import { FolderEditDialogComponent } from '../../chat/folder-edit-dialog/folder-edit-dialog.component';
import { folderIconFor } from '../../chat/folder-icons';

/**
 * The Folders tab: show or hide the built-in rail views, and manage the user's own folders.
 * Hiding writes straight to the appearance document (one debounced save); folder edits reuse the
 * folder store and the same dialog the rail opens.
 */
@Component({
    selector: 'app-folders-settings',
    imports: [LucideAngularModule, FolderEditDialogComponent],
    templateUrl: './folders-settings.component.html',
    styleUrl: './folders-settings.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoldersSettingsComponent {
    private readonly appearance = inject(AppearanceStore);
    private readonly folderStore = inject(FolderStoreService);
    private readonly chatStore = inject(ChatStoreService);
    private readonly confirm = inject(ConfirmService);
    private readonly toast = inject(ToastService);

    readonly views = DEFAULT_VIEWS;
    readonly hidden = computed(() => this.appearance.value().hidden_views);
    readonly folders = this.folderStore.folders;
    readonly chats = this.chatStore.chats;
    readonly dialog = signal<{ folder: Folder | null; focus: 'name' | 'chats' } | null>(null);

    readonly editIcon = SquarePen;
    readonly renameIcon = Pencil;
    readonly deleteIcon = Trash2;
    readonly plusIcon = Plus;
    readonly restoreIcon = RotateCcw;

    readonly folderItems = computed(() =>
        this.folders().map((folder) => ({ folder, icon: folderIconFor(folder.icon), count: folder.items.length }))
    );

    isVisible(id: HiddenViewId): boolean {
        return !this.hidden().includes(id);
    }

    /** The last visible chat view cannot be turned off; the switch says why. */
    isLocked(id: HiddenViewId): boolean {
        return this.isVisible(id) && !canHideView(this.hidden(), id);
    }

    toggle(id: HiddenViewId): void {
        if (this.isVisible(id)) {
            if (!canHideView(this.hidden(), id)) {
                return;
            }
            this.appearance.update({ hidden_views: [...this.hidden(), id] });
        } else {
            this.appearance.update({ hidden_views: this.hidden().filter((v) => v !== id) });
        }
    }

    restoreAll(): void {
        if (this.hidden().length) {
            this.appearance.update({ hidden_views: [] });
        }
    }

    openDialog(folder: Folder | null, focus: 'name' | 'chats' = 'name'): void {
        this.dialog.set({ folder, focus });
    }

    async remove(folder: Folder): Promise<void> {
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
}
