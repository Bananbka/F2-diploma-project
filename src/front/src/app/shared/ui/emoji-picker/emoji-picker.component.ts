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
import { Clock, LucideAngularModule, Search, X } from 'lucide-angular';

import { TwemojiPipe } from '../../emoji/twemoji.pipe';
import { ContextMenuDirective, ContextMenuProvider } from '../context-menu/context-menu.directive';
import { activeSectionKey, JUMP_SETTLE_MS, scrollToSection } from '../section-scroll';
import { EMOJI_CATEGORIES } from './emoji-data';

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
                if (labelHit || emoji.includes(q)) {
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
                this.closeRequested.emit();
            }
        };

        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        this.destroyRef.onDestroy(() => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
        });
    }

    selectCategory(index: number): void {
        this.activeCategory.set(index);
    }

    /** Scroll the embedded list to a section: a category index, or "recent" for "Recently used". */
    jumpTo(section: string): void {
        this.query.set('');
        this.activeSection.set(section);
        this.settleUntil = Date.now() + JUMP_SETTLE_MS;
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

    /** Menu for an entry in "Recently used". Other emoji have no custom actions, so keep the native menu. */
    recentMenu(emoji: string): ContextMenuProvider {
        return () => [{ icon: X, label: 'Remove from Recent', action: () => this.recentRemoved.emit(emoji) }];
    }

    choose(emoji: string): void {
        this.pick.emit(emoji);
    }
}
