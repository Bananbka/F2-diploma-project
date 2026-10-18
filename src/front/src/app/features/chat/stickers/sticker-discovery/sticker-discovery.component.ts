import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ArrowLeft, Check, LucideAngularModule, Plus, Search, Smile } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { StickerPackSummary } from '../../../../core/models/sticker.model';
import { StickerApiService } from '../../../../core/services/sticker-api.service';

/**
 * Browse and search public sticker packs, subscribing adds a pack to the tray without copying its
 * data — `POST/DELETE /stickers/packs/{id}/subscribe`.
 */
@Component({
    selector: 'app-sticker-discovery',
    imports: [LucideAngularModule],
    templateUrl: './sticker-discovery.component.html',
    styleUrl: './sticker-discovery.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StickerDiscoveryComponent {
    private readonly stickerApi = inject(StickerApiService);
    private readonly router = inject(Router);

    readonly query = signal('');
    readonly results = signal<StickerPackSummary[]>([]);
    readonly loading = signal(true);
    readonly error = signal<string | null>(null);

    /** Ids already in the tray (owned or subscribed) — known from `GET /stickers/packs/mine`. */
    readonly subscribedIds = signal(new Set<string>());
    readonly busyId = signal<string | null>(null);

    readonly arrowLeftIcon = ArrowLeft;
    readonly searchIcon = Search;
    readonly plusIcon = Plus;
    readonly checkIcon = Check;
    readonly emptyIcon = Smile;

    private searchTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        void this.loadMine();
        void this.search('');
    }

    private async loadMine(): Promise<void> {
        try {
            const mine = await firstValueFrom(this.stickerApi.getMyPacks());
            this.subscribedIds.set(new Set(mine.map((pack) => pack.id)));
        } catch {
            // Non-fatal: subscribe buttons just won't pre-show as already-added.
        }
    }

    onQuery(value: string): void {
        this.query.set(value);
        if (this.searchTimer) {
            clearTimeout(this.searchTimer);
        }
        this.searchTimer = setTimeout(() => void this.search(value.trim()), 250);
    }

    private async search(term: string): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        try {
            this.results.set(await firstValueFrom(this.stickerApi.getPublicPacks(term || undefined)));
        } catch {
            this.error.set('Could not load public sticker packs.');
        } finally {
            this.loading.set(false);
        }
    }

    isSubscribed(pack: StickerPackSummary): boolean {
        return this.subscribedIds().has(pack.id);
    }

    async toggleSubscribe(pack: StickerPackSummary): Promise<void> {
        this.busyId.set(pack.id);
        const subscribed = this.isSubscribed(pack);
        try {
            if (subscribed) {
                await firstValueFrom(this.stickerApi.unsubscribe(pack.id));
                this.subscribedIds.update((current) => {
                    const next = new Set(current);
                    next.delete(pack.id);
                    return next;
                });
            } else {
                await firstValueFrom(this.stickerApi.subscribe(pack.id));
                this.subscribedIds.update((current) => new Set(current).add(pack.id));
            }
        } catch {
            this.error.set('Could not update that subscription.');
        } finally {
            this.busyId.set(null);
        }
    }

    async close(): Promise<void> {
        await this.router.navigate(['/chats']);
    }
}
