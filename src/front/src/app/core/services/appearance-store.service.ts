import { inject, Injectable, Injector, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Appearance, DEFAULT_APPEARANCE } from '../models/appearance.model';
import { AppearanceApiService } from './appearance-api.service';
import { ToastService } from './toast.service';

export const APPEARANCE_CACHE_KEY = 'appearance.v1';
export const APPEARANCE_PERSIST_DELAY_MS = 600;

function readCache(): Appearance {
    try {
        const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Appearance;
            if (parsed?.version === 1 && typeof parsed.font_size === 'number' && parsed.background) {
                return parsed;
            }
        }
    } catch {
        /* a corrupt or unavailable cache is just a missing one */
    }
    return DEFAULT_APPEARANCE;
}

/**
 * The signed-in user's chat appearance. The server is the source of truth; localStorage only holds
 * the last value so the first paint does not flash defaults before the GET answers.
 *
 * Edits apply immediately and are written to the server after a short pause, so dragging a slider
 * costs one request, not hundreds. A failed write puts back the last value the server confirmed.
 */
@Injectable({ providedIn: 'root' })
export class AppearanceStore {
    private readonly injector = inject(Injector);
    /** Resolved on first use: the session service holds this store only to clear it, and must not pull in HTTP. */
    private get api(): AppearanceApiService {
        return this.injector.get(AppearanceApiService);
    }
    private readonly toast = inject(ToastService);

    private readonly _value = signal<Appearance>(readCache());
    readonly value = this._value.asReadonly();

    /** Last value the server confirmed; what a failed write reverts to. */
    private confirmed: Appearance = this._value();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private loadStarted = false;
    private dirty = false;

    /** Fetch once. Fails silently: defaults (or the cache) stay in place and the UI is never blocked. */
    async load(): Promise<void> {
        if (this.loadStarted) {
            return;
        }
        this.loadStarted = true;
        try {
            const remote = await firstValueFrom(this.api.get());
            this.confirmed = remote;
            // An edit made while the GET was in flight is newer than what the server sent.
            if (!this.dirty) {
                this.set(remote);
            }
        } catch {
            this.loadStarted = false;
        }
    }

    update(partial: Partial<Appearance>): void {
        this.set({ ...this._value(), ...partial, version: 1 });
        this.dirty = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.flush(), APPEARANCE_PERSIST_DELAY_MS);
    }

    async reset(): Promise<void> {
        this.cancelPending();
        const before = this._value();
        this.set(DEFAULT_APPEARANCE);
        try {
            const defaults = await firstValueFrom(this.api.reset());
            this.confirmed = defaults;
            this.set(defaults);
        } catch {
            this.set(before);
            this.toast.error('Could not reset your appearance. Nothing was changed.');
        }
    }

    /**
     * Back to defaults and forget the cache, on sign-out or any session end, so the next account on
     * this browser never sees the previous one's look (and a pending save cannot land on them).
     */
    clear(): void {
        this.cancelPending();
        this.loadStarted = false;
        this.confirmed = DEFAULT_APPEARANCE;
        this._value.set(DEFAULT_APPEARANCE);
        try {
            localStorage.removeItem(APPEARANCE_CACHE_KEY);
        } catch {
            /* cache only */
        }
    }

    private async flush(): Promise<void> {
        this.timer = null;
        const sent = this._value();
        try {
            const saved = await firstValueFrom(this.api.put(sent));
            this.confirmed = saved;
            if (!this.timer) {
                this.dirty = false;
            }
        } catch {
            if (this.timer) {
                return; // a newer edit is already queued and will overwrite this one
            }
            this.dirty = false;
            this.set(this.confirmed);
            this.toast.error('Could not save your appearance. Your previous settings were restored.');
        }
    }

    private cancelPending(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.dirty = false;
    }

    private set(value: Appearance): void {
        this._value.set(value);
        try {
            localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(value));
        } catch {
            /* cache only */
        }
    }
}
