import { inject, Injectable, Injector } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AppearanceApiService } from './appearance-api.service';
import { sampleImageColor } from './image-color';

/**
 * The chat background picture, fetched as a blob (the endpoint needs the session cookie, so it cannot
 * be an `<img src>` pointing at the API) and cached in memory per version, so reopening a chat does
 * not fetch it again. A failure yields null and the caller shows the default background.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundImageService {
    private readonly injector = inject(Injector);
    private get api(): AppearanceApiService {
        return this.injector.get(AppearanceApiService);
    }

    private readonly urls = new Map<string, string>();
    private readonly colors = new Map<string, string | null>();
    private readonly inflight = new Map<string, Promise<string | null>>();
    /** Bumped on clear, so a fetch that finishes after sign-out cannot repopulate the cache. */
    private generation = 0;

    load(version: string): Promise<string | null> {
        const cached = this.urls.get(version);
        if (cached) {
            return Promise.resolve(cached);
        }
        const pending = this.inflight.get(version);
        if (pending) {
            return pending;
        }
        const generation = this.generation;
        const request = (async () => {
            try {
                const blob = await firstValueFrom(this.api.fetchBackgroundImage(version));
                const url = URL.createObjectURL(blob);
                if (generation !== this.generation) {
                    URL.revokeObjectURL(url);
                    return null;
                }
                this.urls.set(version, url);
                return url;
            } catch {
                return null;
            } finally {
                this.inflight.delete(version);
            }
        })();
        this.inflight.set(version, request);
        return request;
    }

    /** The picture's average colour, sampled once per version. */
    async colorFor(version: string): Promise<string | null> {
        if (this.colors.has(version)) {
            return this.colors.get(version) ?? null;
        }
        const url = await this.load(version);
        const color = url ? await sampleImageColor(url) : null;
        if (url) {
            this.colors.set(version, color);
        }
        return color;
    }

    clear(): void {
        this.generation++;
        for (const url of this.urls.values()) {
            URL.revokeObjectURL(url);
        }
        this.urls.clear();
        this.colors.clear();
        this.inflight.clear();
    }
}
