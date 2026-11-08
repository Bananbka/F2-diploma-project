import { computed, Injectable, signal } from '@angular/core';

import { typeMayBeTransparent } from '../../../shared/utils/image-meta';

export interface ViewerItem {
    /** The attachment url: unique per file, and what a bubble registers and unregisters it under. */
    key: string;
    messageId: string;
    /** The already-decrypted blob the bubble drew; the viewer does not fetch or decrypt again. */
    objectUrl: string;
    name: string;
    contentType: string;
    kind: 'image' | 'gif';
    sender: string;
    time: string;
}

interface Entry extends ViewerItem {
    chatId: string;
}

/** Content types that can have transparent pixels, so they get a white backing. */
export function canHaveAlpha(contentType: string): boolean {
    return typeMayBeTransparent(contentType);
}

/**
 * The pictures currently decrypted on screen, so a viewer can step through a chat's media without
 * decrypting anything a second time. Bubbles register what they have drawn and unregister it when
 * they go (their blob URLs are revoked then), so every entry here is always a live URL.
 */
@Injectable({ providedIn: 'root' })
export class MediaViewerService {
    private readonly entries = signal<ReadonlyMap<string, Entry>>(new Map());
    /** Which picture is open, if any. */
    readonly current = signal<{ chatId: string; key: string } | null>(null);

    /** All media of a chat in message order (ObjectIds sort chronologically), then attachment order. */
    itemsOf(chatId: string): ViewerItem[] {
        return [...this.entries().values()]
            .filter((e) => e.chatId === chatId)
            .sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
    }

    readonly items = computed(() => {
        const open = this.current();
        return open ? this.itemsOf(open.chatId) : [];
    });
    readonly index = computed(() => {
        const open = this.current();
        return open ? this.items().findIndex((i) => i.key === open.key) : -1;
    });
    readonly item = computed(() => this.items()[this.index()] ?? null);

    register(chatId: string, item: ViewerItem): void {
        this.entries.update((all) => new Map(all).set(item.key, { ...item, chatId }));
    }

    unregister(key: string): void {
        if (!this.entries().has(key)) {
            return;
        }
        this.entries.update((all) => {
            const next = new Map(all);
            next.delete(key);
            return next;
        });
        if (this.current()?.key === key) {
            this.current.set(null);
        }
    }

    open(chatId: string, key: string): void {
        if (this.entries().has(key)) {
            this.current.set({ chatId, key });
        }
    }

    step(delta: number): void {
        const open = this.current();
        const items = this.items();
        const next = items[this.index() + delta];
        if (open && next) {
            this.current.set({ chatId: open.chatId, key: next.key });
        }
    }

    close(): void {
        this.current.set(null);
    }
}
