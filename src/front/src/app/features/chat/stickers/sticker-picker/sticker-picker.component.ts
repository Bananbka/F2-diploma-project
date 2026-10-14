import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    ElementRef,
    inject,
    output,
    signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Compass, LucideAngularModule, Search, Settings2, Smile } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Sticker, StickerPack, StickerPackSummary } from '../../../../core/models/sticker.model';
import { StickerApiService } from '../../../../core/services/sticker-api.service';

/**
 * The sticker tray popover, opened from the composer.
 *
 * Mirrors the reaction tray's own popover pattern in `message-bubble` — a dismiss-on-outside-click
 * listener registered for this component's lifetime, rather than a shared overlay service, since
 * nothing else in this codebase has one either.
 *
 * `GET /stickers/packs/mine` returns the lighter `StickerPackSummary` shape (title, cover image,
 * count — no sticker list), so the actual stickers for a pack are fetched lazily the first time its
 * tab is opened and cached here for the rest of this popover's life.
 */
@Component({
    selector: 'app-sticker-picker',
    imports: [LucideAngularModule, RouterLink],
    templateUrl: './sticker-picker.component.html',
    styleUrl: './sticker-picker.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StickerPickerComponent {
    private readonly stickerApi = inject(StickerApiService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly closeRequested = output<void>();
    readonly stickerPicked = output<Sticker>();

    readonly tray = signal<StickerPackSummary[]>([]);
    readonly activePackId = signal<string | null>(null);
    readonly packDetails = signal<Map<string, StickerPack>>(new Map());
    readonly query = signal('');

    readonly loadingTray = signal(true);
    readonly loadingPack = signal(false);
    readonly error = signal<string | null>(null);

    readonly searchIcon = Search;
    readonly manageIcon = Settings2;
    readonly discoverIcon = Compass;
    readonly emptyIcon = Smile;

    readonly activeStickers = computed<Sticker[]>(() => {
        const packId = this.activePackId();
        return packId ? (this.packDetails().get(packId)?.stickers ?? []) : [];
    });

    readonly filteredStickers = computed<Sticker[]>(() => {
        const q = this.query().trim();
        const list = this.activeStickers();
        return q ? list.filter((sticker) => sticker.emoji.includes(q)) : list;
    });

    constructor() {
        void this.loadTray();

        // Same dismissal rule as the reaction tray in message-bubble: any mousedown outside this
        // popover's own DOM asks the host to close it. The trigger that opened this popover is
        // excluded via `.sticker-trigger` (mirroring message-bubble's own `.react-trigger` check) —
        // without it, the mousedown that is about to close the tray would fire first, and the click
        // that follows on the same button would immediately reopen it.
        const onPointerDown = (event: MouseEvent): void => {
            const target = event.target as HTMLElement;
            if (!this.elementRef.nativeElement.contains(target) && !target.closest('.sticker-trigger')) {
                this.closeRequested.emit();
            }
        };
        document.addEventListener('mousedown', onPointerDown, true);
        this.destroyRef.onDestroy(() => document.removeEventListener('mousedown', onPointerDown, true));
    }

    private async loadTray(): Promise<void> {
        this.loadingTray.set(true);
        this.error.set(null);
        try {
            const packs = await firstValueFrom(this.stickerApi.getMyPacks());
            this.tray.set(packs);
            if (packs.length > 0) {
                await this.selectPack(packs[0].id);
            }
        } catch {
            this.error.set('Could not load your stickers.');
        } finally {
            this.loadingTray.set(false);
        }
    }

    async selectPack(packId: string): Promise<void> {
        this.activePackId.set(packId);
        this.query.set('');

        if (this.packDetails().has(packId)) {
            return;
        }

        this.loadingPack.set(true);
        this.error.set(null);
        try {
            const pack = await firstValueFrom(this.stickerApi.getPack(packId));
            this.packDetails.update((current) => new Map(current).set(packId, pack));
        } catch {
            this.error.set('Could not load that pack.');
        } finally {
            this.loadingPack.set(false);
        }
    }

    pick(sticker: Sticker): void {
        this.stickerPicked.emit(sticker);
    }
}
