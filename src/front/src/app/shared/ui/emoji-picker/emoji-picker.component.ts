import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    ElementRef,
    inject,
    input,
    output,
    signal,
} from '@angular/core';
import {
    Car,
    Clock,
    Flag,
    Hand,
    Lightbulb,
    LucideAngularModule,
    PawPrint,
    Search,
    Shapes,
    Smile,
    Trophy,
    Utensils,
    X,
} from 'lucide-angular';

import { TwemojiPipe } from '../../emoji/twemoji.pipe';
import { ContextMenuDirective, ContextMenuProvider } from '../context-menu/context-menu.directive';
import { activeSectionKey, JUMP_SETTLE_MS, scrollToSection } from '../section-scroll';
import { EMOJI_CATEGORIES, EMOJI_NAMES, EMOJI_TONEABLE } from './emoji-data';

const TONE_STORAGE_KEY = 'emoji-skin-tone';
const TONE_MODIFIERS = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'] as const;
const TONE_LABELS = ['Default', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'] as const;

/** Sections rendered up front; the rest fill in as the list scrolls toward them. */
const INITIAL_SECTIONS = 2;
/** Grid cell pitch (2.375rem cell + 0.125rem gap at 16px), used to size not-yet-rendered sections. */
const CELL_PX = 40;

/**
 * A curated emoji-grid popover, opened from a trigger button.
 *
 * Mirrors `StickerPickerComponent`'s own popover pattern — a dismiss-on-outside-click listener
 * registered for this component's lifetime rather than a shared overlay service, since nothing
 * else in this codebase has one either. The trigger is excluded via `.emoji-trigger` the same way
 * the sticker tray excludes `.sticker-trigger`: without it, the mousedown that is about to close
 * this popover would fire first, and the click that follows on the same button would immediately
 * reopen it.
 *
 * Escape-to-dismiss is borrowed from `ContextMenuComponent`'s popover, which the sticker tray does
 * not have — added here because a grid of ~200 buttons is exactly the kind of surface a keyboard
 * user wants a fast way out of.
 */
@Component({
    selector: 'app-emoji-picker',
    imports: [TwemojiPipe, LucideAngularModule, ContextMenuDirective],
    templateUrl: './emoji-picker.component.html',
    styleUrl: './emoji-picker.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '[class.is-embedded]': 'embedded()' },
})
export class EmojiPickerComponent {
    private readonly destroyRef = inject(DestroyRef);
    private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

    /**
     * Rendered inline inside a panel rather than as a popover: static layout, fills its container,
     * and never asks to be closed (outside clicks and Escape belong to whoever hosts it).
     */
    readonly embedded = input(false);

    /** Emoji to list under "Recently used" (embedded mode only; the host decides what counts). */
    readonly recents = input<readonly string[]>([]);

    readonly pick = output<string>();
    readonly closeRequested = output<void>();
    /** "Remove from Recent" was chosen for this emoji; the host owns the list. */
    readonly recentRemoved = output<string>();

    readonly categories = EMOJI_CATEGORIES;
    readonly activeCategory = signal(0);
    readonly query = signal('');
    /** Embedded mode: the section in view ("recent" or a category index), highlighted in the bar. */
    readonly activeSection = signal<string>('0');
    private settleUntil = 0;

    readonly names: Readonly<Record<string, string | undefined>> = EMOJI_NAMES;

    /** Embedded mode renders a category's grid only once the list has scrolled near it (about 1900 images otherwise). */
    readonly loaded = signal<ReadonlySet<number>>(new Set(Array.from({ length: INITIAL_SECTIONS }, (_, i) => i)));
    private readonly columns = signal(7);

    /** Skin tone applied to every emoji that supports one: an index into the five tones, 0 for none. */
    readonly tone = signal(this.readTone());
    readonly toneSample = computed(() => this.shown('\u{1F44B}'));
    readonly toneLabel = computed(() => TONE_LABELS[this.tone()]);

    /** One icon per entry of `EMOJI_CATEGORIES`, same order: the standard Unicode group order. */
    readonly categoryIcons = [Smile, Hand, PawPrint, Utensils, Car, Trophy, Lightbulb, Shapes, Flag] as const;
    readonly searchIcon = Search;
    readonly recentIcon = Clock;

    /**
     * Search results, or null when there is no query. There are no per-emoji names in the curated
     * data, so a query matches an emoji character itself or a category's label (typing "face"
     * lists the Faces category).
     */
    readonly results = computed<string[] | null>(() => {
        const q = this.query().trim().toLowerCase();
        if (!q) {
            return null;
        }
        const found = new Set<string>();
        for (const category of this.categories) {
            const labelHit = category.label.toLowerCase().includes(q);
            for (const emoji of category.emoji) {
                if (labelHit || emoji.includes(q) || (EMOJI_NAMES[emoji] ?? '').includes(q)) {
                    found.add(emoji);
                }
            }
        }
        return [...found];
    });

    constructor() {
        const onPointerDown = (event: MouseEvent): void => {
            if (this.embedded()) {
                return;
            }
            const target = event.target as HTMLElement;
            if (!this.elementRef.nativeElement.contains(target) && !target.closest('.emoji-trigger')) {
                this.closeRequested.emit();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && !this.embedded()) {
                // Capture phase + stop: Escape dismisses this popover only, never a dialog around it.
                event.stopPropagation();
                this.closeRequested.emit();
            }
        };

        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        this.destroyRef.onDestroy(() => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
        });
    }

    /** The emoji as displayed (and inserted): with the chosen skin tone when it takes one. */
    shown(emoji: string): string {
        const modifier = TONE_MODIFIERS[this.tone()];
        if (!modifier || !EMOJI_TONEABLE.has(emoji)) {
            return emoji;
        }
        const [first, ...rest] = [...emoji.replace(/️/g, '')];
        return first + modifier + rest.join('');
    }

    cycleTone(): void {
        const next = (this.tone() + 1) % TONE_MODIFIERS.length;
        this.tone.set(next);
        try {
            localStorage.setItem(TONE_STORAGE_KEY, String(next));
        } catch {
            // Storage can be unavailable (private mode); the choice then lasts for the session.
        }
    }

    private readTone(): number {
        try {
            const stored = Number(localStorage.getItem(TONE_STORAGE_KEY));
            return Number.isInteger(stored) && stored >= 0 && stored < TONE_MODIFIERS.length ? stored : 0;
        } catch {
            return 0;
        }
    }

    /** Height reserved for a section whose grid is not rendered yet, so the scrollbar and jumps stay roughly true. */
    placeholderHeight(index: number): number {
        return Math.ceil(this.categories[index].emoji.length / this.columns()) * CELL_PX;
    }

    private load(indexes: Iterable<number>): void {
        const next = new Set(this.loaded());
        for (const index of indexes) {
            next.add(index);
        }
        if (next.size !== this.loaded().size) {
            this.loaded.set(next);
        }
    }

    /** Render the sections up to three screens below the top of the viewport. */
    private revealNear(list: HTMLElement): void {
        this.columns.set(Math.max(1, Math.floor((list.clientWidth - 16) / CELL_PX)));
        const limit = list.scrollTop + list.clientHeight * 3;
        const near: number[] = [];
        list.querySelectorAll<HTMLElement>('section[data-section]').forEach((section) => {
            const index = Number(section.dataset['section']);
            if (Number.isInteger(index) && section.offsetTop < limit) {
                near.push(index);
            }
        });
        this.load(near);
    }

    selectCategory(index: number): void {
        this.activeCategory.set(index);
    }

    /** Scroll the embedded list to a section: a category index, or "recent" for "Recently used". */
    jumpTo(section: string): void {
        this.query.set('');
        this.activeSection.set(section);
        this.settleUntil = Date.now() + JUMP_SETTLE_MS;
        const index = Number(section);
        if (Number.isInteger(index)) {
            this.load([index]);
        }
        // Wait for the next render so a cleared search has re-rendered the sections.
        setTimeout(() => {
            const list = this.scroller();
            if (list) {
                scrollToSection(list, section);
            }
        });
    }

    /** Scroll spy: keep the bar's highlight on the section whose title is pinned at the top. */
    onScroll(): void {
        const list = this.scroller();
        if (!list) {
            return;
        }
        this.revealNear(list);
        if (Date.now() < this.settleUntil) {
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

    /** Menu for an entry in "Recently used". Other emoji have no custom actions, so keep the native menu. */
    recentMenu(emoji: string): ContextMenuProvider {
        return () => [{ icon: X, label: 'Remove from Recent', action: () => this.recentRemoved.emit(emoji) }];
    }

    choose(emoji: string): void {
        this.pick.emit(emoji);
    }
}
