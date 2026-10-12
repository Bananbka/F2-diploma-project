import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, output, signal } from '@angular/core';

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
    imports: [],
    templateUrl: './emoji-picker.component.html',
    styleUrl: './emoji-picker.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmojiPickerComponent {
    private readonly destroyRef = inject(DestroyRef);
    private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly pick = output<string>();
    readonly closeRequested = output<void>();

    readonly categories = EMOJI_CATEGORIES;
    readonly activeCategory = signal(0);

    constructor() {
        const onPointerDown = (event: MouseEvent): void => {
            const target = event.target as HTMLElement;
            if (!this.elementRef.nativeElement.contains(target) && !target.closest('.emoji-trigger')) {
                this.closeRequested.emit();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
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

    choose(emoji: string): void {
        this.pick.emit(emoji);
    }
}
