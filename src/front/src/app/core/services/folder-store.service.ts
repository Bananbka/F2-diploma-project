import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Folder, FolderApiService } from './folder-api.service';

/**
 * The user's chat folders.
 *
 * Folders are a view over the chat list, not a place chats live, so every failure here is
 * recoverable and reported as `false` for the caller to word. The unfiltered list never depends on
 * this loading.
 */
@Injectable({ providedIn: 'root' })
export class FolderStoreService {
    private readonly api = inject(FolderApiService);

    readonly folders = signal<Folder[]>([]);
    /** Set once a load has succeeded, so the UI can tell "no folders" from "not known yet". */
    readonly loaded = signal(false);
    /** The last refresh failed. The list shown is the last one that was fetched, not a guess. */
    readonly loadFailed = signal(false);

    /** Writes to one folder run one after another, so two quick edits cannot overwrite each other. */
    private readonly queues = new Map<string, Promise<unknown>>();

    /**
     * Fetch the folders. A failed refresh keeps what is already shown: wiping the list on a network
     * blip would make every folder (and the filter the user is looking at) vanish.
     */
    async load(): Promise<void> {
        try {
            this.folders.set(await firstValueFrom(this.api.getFolders()));
            this.loaded.set(true);
            this.loadFailed.set(false);
        } catch {
            this.loadFailed.set(true);
        }
    }

    async create(title: string, chatIds: string[], icon: string | null = null): Promise<Folder | null> {
        try {
            const folder = await firstValueFrom(this.api.createFolder(title.trim(), chatIds, icon));
            this.folders.update((all) => [...all.filter((f) => f.id !== folder.id), folder]);
            await this.load();
            return folder;
        } catch {
            return null;
        }
    }

    /**
     * Rename and/or re-populate a folder. `chatIds` is the complete resulting membership, because
     * the API replaces it wholesale: a delta would silently empty the folder. Omit it to leave the
     * membership alone.
     */
    update(folderId: string, changes: { title?: string; chatIds?: string[]; icon?: string | null }): Promise<boolean> {
        return this.enqueue(folderId, async () => {
            try {
                const saved = await firstValueFrom(
                    this.api.updateFolder(folderId, {
                        ...(changes.title !== undefined ? { title: changes.title.trim() } : {}),
                        ...(changes.chatIds !== undefined ? { chat_ids: changes.chatIds } : {}),
                        ...(changes.icon !== undefined ? { icon: changes.icon } : {}),
                    })
                );
                if (saved) {
                    this.folders.update((all) => all.map((f) => (f.id === folderId ? saved : f)));
                }
            } catch {
                return false;
            }
            await this.load();
            return true;
        });
    }

    /**
     * Put a chat in a folder, or take it out. The membership is read inside the queued step, from
     * the folder as the previous step left it, so a second toggle never starts from a stale copy.
     */
    toggleChat(folderId: string, chatId: string): Promise<boolean> {
        return this.enqueue(folderId, async () => {
            const folder = this.folders().find((f) => f.id === folderId);
            if (!folder) {
                return false;
            }
            const current = folder.items.map((item) => item.chat_id);
            const next = current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId];
            try {
                const saved = await firstValueFrom(this.api.updateFolder(folderId, { chat_ids: next }));
                if (saved) {
                    this.folders.update((all) => all.map((f) => (f.id === folderId ? saved : f)));
                }
            } catch {
                return false;
            }
            await this.load();
            return true;
        });
    }

    async remove(folder: Folder): Promise<boolean> {
        try {
            await firstValueFrom(this.api.deleteFolder(folder.id));
            this.folders.update((all) => all.filter((f) => f.id !== folder.id));
            await this.load();
            return true;
        } catch {
            return false;
        }
    }

    private enqueue(folderId: string, step: () => Promise<boolean>): Promise<boolean> {
        const previous = this.queues.get(folderId) ?? Promise.resolve();
        const run = previous.then(step, step);
        this.queues.set(folderId, run);
        // Drop the entry once idle so the map does not grow with every folder ever touched.
        const clear = () => {
            if (this.queues.get(folderId) === run) {
                this.queues.delete(folderId);
            }
        };
        run.then(clear, clear);
        return run;
    }
}
