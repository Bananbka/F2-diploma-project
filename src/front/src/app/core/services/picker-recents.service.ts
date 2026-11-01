import { computed, inject, Injectable, signal } from '@angular/core';

import { SessionService } from './session.service';

export type RecentKind = 'emoji' | 'stickers';

const LIMITS: Record<RecentKind, number> = { emoji: 32, stickers: 24 };

/**
 * "Recently used" emoji and stickers for the side-panel picker, remembered per user.
 *
 * Kept in localStorage under the signed-in user's id so two accounts on one browser do not see each
 * other's habits. It is a convenience preference with no security weight, so storage failures
 * (private mode, disabled storage, quota) are swallowed and the list simply lives for the session.
 * Stickers are remembered by id only and resolved against the user's loaded packs by the picker,
 * so a stored value is never used as an image URL and a deleted sticker just drops out.
 */
@Injectable({ providedIn: 'root' })
export class PickerRecentsService {
    private readonly session = inject(SessionService);
    private readonly cache = signal<Record<string, string[]>>({});

    readonly emoji = computed(() => this.read('emoji'));
    readonly stickerIds = computed(() => this.read('stickers'));

    addEmoji(emoji: string): void {
        this.add('emoji', emoji);
    }

    addSticker(stickerId: string): void {
        this.add('stickers', stickerId);
    }

    private key(kind: RecentKind): string | null {
        const id = this.session.user()?.id;
        return id ? `picker-recents:${id}:${kind}` : null;
    }

    private read(kind: RecentKind): string[] {
        const key = this.key(kind);
        if (!key) {
            return [];
        }
        const cached = this.cache()[key];
        if (cached) {
            return cached;
        }
        try {
            const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
            if (Array.isArray(parsed)) {
                return parsed.filter((value): value is string => typeof value === 'string').slice(0, LIMITS[kind]);
            }
        } catch {
            // Unreadable or tampered value: start over.
        }
        return [];
    }

    private add(kind: RecentKind, value: string): void {
        const key = this.key(kind);
        if (!key || !value) {
            return;
        }
        const next = [value, ...this.read(kind).filter((existing) => existing !== value)].slice(0, LIMITS[kind]);
        this.cache.update((current) => ({ ...current, [key]: next }));
        try {
            localStorage.setItem(key, JSON.stringify(next));
        } catch {
            // Session-only is fine.
        }
    }
}
