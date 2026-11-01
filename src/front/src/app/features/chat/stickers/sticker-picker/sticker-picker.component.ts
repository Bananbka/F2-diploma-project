import {
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Clock, Compass, Layers, LucideAngularModule, Search, Settings2, Smile, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { Sticker, StickerPack, StickerPackSummary } from '../../../../core/models/sticker.model';
import { StickerApiService } from '../../../../core/services/sticker-api.service';
import { ContextMenuDirective, ContextMenuProvider } from '../../../../shared/ui/context-menu/context-menu.directive';
import { ContextMenuEntry } from '../../../../shared/ui/context-menu/context-menu.model';
import { activeSectionKey, JUMP_SETTLE_MS, scrollToSection } from '../../../../shared/ui/section-scroll';
import { StickerPackViewerService } from '../sticker-pack-dialog/sticker-pack-viewer';

/** A labelled run of stickers: one of the user's packs. */
interface PackSection {
    id: string;
    title: string;
    stickers: Sticker[];
}

/**
 * The Stickers tab of the side panel: search, "Recently used", one labelled section per pack of the
 * user's, and a bottom bar of pack icons that scrolls to a section.
 *
 * `GET /stickers/packs/mine` returns the lighter `StickerPackSummary` shape (title, cover image,
 * count, no sticker list), so every pack's stickers are then fetched once (in parallel) and kept for
 * this component's life. A pack that fails to load is simply absent and an error line is shown,
 * rather than blocking the packs that did load.
 *
 * It never talks to the composer: it emits `stickerPicked` and the panel routes it through the
 * composer bridge, so the composer's guards apply.
 */
@Component({
    selector: 'app-sticker-picker',
    imports: [LucideAngularModule, RouterLink, ContextMenuDirective],
    templateUrl: './sticker-picker.component.html',
    styleUrl: './sticker-picker.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StickerPickerComponent implements OnInit {
    private readonly stickerApi = inject(StickerApiService);
    private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
    private readonly packViewer = inject(StickerPackViewerService);

    /** Ids of recently used stickers, newest first. Resolved against loaded packs, never trusted as urls. */
    readonly recentIds = input<readonly string[]>([]);

    readonly stickerPicked = output<Sticker>();
    /** "Remove from Recent" was chosen for this sticker id; the host owns the list. */
    readonly recentRemoved = output<string>();

    readonly tray = signal<StickerPackSummary[]>([]);
    readonly packDetails = signal<Map<string, StickerPack>>(new Map());
    /** The section in view (a pack id or "recent"), highlighted in the bar. */
    readonly activeSection = signal<string | null>(null);
    private settleUntil = 0;
    readonly query = signal('');

    readonly loading = signal(true);
    readonly error = signal<string | null>(null);

    readonly searchIcon = Search;
    readonly manageIcon = Settings2;
    readonly discoverIcon = Compass;
    readonly emptyIcon = Smile;
    readonly recentIcon = Clock;

    readonly sections = computed<PackSection[]>(() =>
        this.tray()
            .map((pack) => ({
                id: pack.id,
                title: pack.title,
                stickers: this.packDetails().get(pack.id)?.stickers ?? [],
            }))
            .filter((section) => section.stickers.length > 0)
    );

    readonly recents = computed<Sticker[]>(() => {
        const byId = new Map<string, Sticker>();
        for (const section of this.sections()) {
            for (const sticker of section.stickers) {
                byId.set(sticker.id, sticker);
            }
        }
        return this.recentIds()
            .map((id) => byId.get(id))
            .filter((sticker): sticker is Sticker => sticker !== undefined);
    });

    /** Search results across every pack, or null when there is no query. */
    readonly results = computed<Sticker[] | null>(() => {
        const q = this.query().trim();
        if (!q) {
            return null;
        }
        return this.sections()
            .flatMap((section) => section.stickers)
            .filter((sticker) => sticker.emoji.includes(q));
    });

    ngOnInit(): void {
        void this.load();
    }

    private async load(): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        try {
            const packs = await firstValueFrom(this.stickerApi.getMyPacks());
            this.tray.set(packs);
            this.activeSection.set(packs[0]?.id ?? null);

            const loaded = await Promise.allSettled(
                packs.map((pack) => firstValueFrom(this.stickerApi.getPack(pack.id)))
            );
            const details = new Map<string, StickerPack>();
            let failed = false;
            for (const result of loaded) {
                if (result.status === 'fulfilled') {
                    details.set(result.value.id, result.value);
                } else {
                    failed = true;
                }
            }
            this.packDetails.set(details);
            if (failed) {
                this.error.set('Some packs could not be loaded.');
            }
        } catch {
            this.error.set('Could not load your stickers.');
        } finally {
            this.loading.set(false);
        }
    }

    /** Smooth-scroll to a pack's section, or to "Recently used" with `'recent'`. */
    jumpTo(target: string): void {
        this.query.set('');
        this.activeSection.set(target);
        this.settleUntil = Date.now() + JUMP_SETTLE_MS;
        // Wait for the next render so a cleared search has re-rendered the sections.
        setTimeout(() => {
            const list = this.scroller();
            if (list) {
                scrollToSection(list, target);
            }
        });
    }

    /** Scroll spy: keep the bar's highlight on the pack whose title is pinned at the top. */
    onScroll(): void {
        const list = this.scroller();
        if (!list || Date.now() < this.settleUntil) {
            return;
        }
        const key = activeSectionKey(list);
        if (key !== null) {
            this.activeSection.set(key);
        }
    }

    private scroller(): HTMLElement | null {
        return this.elementRef.nativeElement.querySelector<HTMLElement>('.scroll');
    }

    /**
     * Menu for a sticker: its pack, and, in "Recently used", forgetting it. The pack dialog resolves
     * the pack from the sticker's image url, so that is all it needs.
     */
    stickerMenu(sticker: Sticker, recent: boolean): ContextMenuProvider {
        return () => {
            const entries: ContextMenuEntry[] = [
                { icon: Layers, label: 'View Sticker Set', action: () => this.packViewer.open(sticker.image_url) },
            ];
            if (recent) {
                entries.push({
                    icon: X,
                    label: 'Remove from Recent',
                    action: () => this.recentRemoved.emit(sticker.id),
                });
            }
            return entries;
        };
    }

    pick(sticker: Sticker): void {
        this.stickerPicked.emit(sticker);
    }
}
