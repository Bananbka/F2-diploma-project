import {
    ChangeDetectionStrategy,
    Component,
    effect,
    ElementRef,
    input,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import { LucideAngularModule, Smile } from 'lucide-angular';

import { EmojiPickerComponent } from '../emoji-picker/emoji-picker.component';
import { insertAtCaret, TextControl } from './insert-at-caret';

const GAP = 4;
const MARGIN = 8;
/** Above the modal card (71) and anything else in the app. */
const POPOVER_Z_INDEX = 100;

export interface Point {
    readonly left: number;
    readonly top: number;
}

/**
 * Where to put a popover of `size` next to `anchor`: right edges aligned, below the anchor when it
 * fits (or when there is more room below than above), otherwise flipped above, and always clamped
 * inside the viewport.
 */
export function placePopover(
    anchor: { top: number; bottom: number; right: number },
    size: { width: number; height: number },
    viewport: { width: number; height: number }
): Point {
    const clamp = (value: number, min: number, max: number): number =>
        Math.min(Math.max(value, min), Math.max(min, max));
    const below = viewport.height - anchor.bottom - MARGIN - GAP;
    const above = anchor.top - MARGIN - GAP;
    const top = size.height <= below || below >= above ? anchor.bottom + GAP : anchor.top - GAP - size.height;
    return {
        left: clamp(anchor.right - size.width, MARGIN, viewport.width - size.width - MARGIN),
        top: clamp(top, MARGIN, viewport.height - size.height - MARGIN),
    };
}

/**
 * A small smiley button that opens the shared emoji picker and inserts the chosen emoji, as plain
 * Unicode, at the caret of `target`. Place it next to the field inside an `.emoji-input-wrap`
 * (global style) and pass the field's template reference: `<app-emoji-button [target]="field" />`.
 *
 * The popover is moved to `document.body` and positioned with `position: fixed` from the trigger's
 * rect. Rendered in place it was clipped by a dialog's scroll area and sat in the stacking context
 * of the field wrapper, so the next field and its own emoji button painted through it; a dialog card
 * is also `transform`ed, which would make `fixed` relative to the card rather than the viewport.
 */
@Component({
    selector: 'app-emoji-button',
    imports: [LucideAngularModule, EmojiPickerComponent],
    template: `
        <button
            #trigger
            type="button"
            class="emoji-trigger trigger"
            aria-haspopup="dialog"
            [attr.aria-expanded]="open()"
            aria-label="Insert emoji"
            title="Insert emoji"
            (click)="open.set(!open())"
        >
            <lucide-icon [img]="icon" />
        </button>
        @if (open()) {
            <app-emoji-picker
                (closeRequested)="close()"
                (pick)="onPick($event)"
            />
        }
    `,
    styleUrl: './emoji-button.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmojiButtonComponent {
    readonly target = input.required<TextControl | null | undefined>();

    readonly open = signal(false);
    readonly icon = Smile;

    private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
    private readonly picker = viewChild(EmojiPickerComponent, { read: ElementRef });

    constructor() {
        effect((onCleanup) => {
            const ref = this.picker();
            if (!ref) {
                return;
            }
            const element = ref.nativeElement as HTMLElement;
            const reposition = (event?: Event): void => {
                // Scrolling inside the popover itself must not move it.
                if (event?.target instanceof Node && element.contains(event.target)) {
                    return;
                }
                this.place(element);
            };

            untracked(() => {
                document.body.appendChild(element);
                element.style.position = 'fixed';
                element.style.zIndex = String(POPOVER_Z_INDEX);
                element.style.right = 'auto';
                element.style.bottom = 'auto';
                this.place(element);
            });

            window.addEventListener('resize', reposition);
            window.addEventListener('scroll', reposition, true);
            onCleanup(() => {
                window.removeEventListener('resize', reposition);
                window.removeEventListener('scroll', reposition, true);
                element.remove();
            });
        });
    }

    /** Close the popover; if focus was inside it (Escape, or a pick), hand focus back to the field. */
    close(): void {
        const picker = this.picker()?.nativeElement as HTMLElement | undefined;
        const hadFocus = !!picker && picker.contains(document.activeElement);
        this.open.set(false);
        if (hadFocus) {
            this.target()?.focus();
        }
    }

    onPick(emoji: string): void {
        const control = this.target();
        if (!control) {
            return;
        }
        insertAtCaret(control, emoji);
        control.focus();
    }

    private place(element: HTMLElement): void {
        const anchor = this.trigger().nativeElement.getBoundingClientRect();
        const { left, top } = placePopover(
            anchor,
            { width: element.offsetWidth, height: element.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight }
        );
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
    }
}
