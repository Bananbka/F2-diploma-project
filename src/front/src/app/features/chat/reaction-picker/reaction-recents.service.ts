import { inject, Injectable, signal } from '@angular/core';

import { SessionService } from '../../../core/services/session.service';

export const DEFAULT_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
export const RECENT_REACTIONS_CAP = 8;
/** How many reactions the quick bar shows when there is little history. */
export const QUICK_BAR_MIN = 6;

/**
 * The reactions this user used most recently, newest first, kept per account in localStorage so a
 * second account on the same browser never sees the first one's habits. Storage can be unavailable;
 * the list then lasts for the session.
 */
@Injectable({ providedIn: 'root' })
export class ReactionRecentsService {
    private readonly session = inject(SessionService);

    private readonly list = signal<string[]>([]);
    private loadedFor: string | null = null;

    private get key(): string {
        return `reaction-recents.v1:${this.session.user()?.id ?? 'anon'}`;
    }

    /** Recents, newest first (reloaded if the signed-in account changed). */
    recents(): readonly string[] {
        this.ensureLoaded();
        return this.list();
    }

    /** What the quick bar shows: recents, topped up from the defaults when there is little history. */
    quickBar(): string[] {
        const bar = [...this.recents()];
        for (const emoji of DEFAULT_REACTIONS) {
            if (bar.length >= QUICK_BAR_MIN) {
                break;
            }
            if (!bar.includes(emoji)) {
                bar.push(emoji);
            }
        }
        return bar;
    }

    /** Move to the front, drop duplicates, and cap the list. */
    record(emoji: string): void {
        this.ensureLoaded();
        const next = [emoji, ...this.list().filter((e) => e !== emoji)].slice(0, RECENT_REACTIONS_CAP);
        this.list.set(next);
        try {
            localStorage.setItem(this.key, JSON.stringify(next));
        } catch {
            /* session-only */
        }
    }

    private ensureLoaded(): void {
        const key = this.key;
        if (this.loadedFor === key) {
            return;
        }
        this.loadedFor = key;
        let stored: string[] = [];
        try {
            const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
            if (Array.isArray(raw)) {
                stored = raw.filter((e): e is string => typeof e === 'string').slice(0, RECENT_REACTIONS_CAP);
            }
        } catch {
            /* a corrupt entry is an empty one */
        }
        this.list.set(stored);
    }
}
