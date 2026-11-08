import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';

import { placePopover } from '../emoji-field/emoji-button.component';
import { clamp01, hexToHsv, Hsv, hsvToHex, normalizeHex } from './color-utils';

/** Above the modal card (71) and anything else in the app, same as the emoji popover. */
const POPOVER_Z_INDEX = 100;
const FALLBACK_SIZE = { width: 248, height: 330 };

/**
 * A colour picker in the app's own style: a round trigger that opens a popover with a
 * saturation/brightness square, a hue slider, a hex field, preset swatches and a "Default" action.
 *
 * The popover is moved to `document.body` and positioned with `position: fixed`, like the emoji
 * popover, so a dialog's scroll area cannot clip it. Escape closes only the popover (the capture
 * listener stops the event before the dialog's own Escape handling sees it), and a press outside
 * closes it. Every pointer drag ends through one `endDrag`, whichever way it stops.
 */
@Component({
    selector: 'app-color-picker',
    templateUrl: './color-picker.component.html',
    styleUrl: './color-picker.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColorPickerComponent {
    /** The current colour as `#rrggbb`, or null when the default is in use. */
    readonly color = input<string | null>(null);
    /** Where the picker starts when there is no colour yet. */
    readonly fallback = input('#a358f9');
    readonly swatches = input<readonly string[]>([]);
    readonly label = input.required<string>();

    readonly colorChange = output<string>();
    readonly cleared = output<void>();

    readonly open = signal(false);
    readonly hsv = signal<Hsv>({ h: 0, s: 1, v: 1 });
    readonly draft = signal('');
    readonly draftInvalid = signal(false);

    private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
    private readonly popover = viewChild<ElementRef<HTMLElement>>('popover');
    private readonly square = viewChild<ElementRef<HTMLElement>>('square');

    private dragTarget: { element: HTMLElement; pointerId: number; kind: 'square' | 'hue' } | null = null;

    constructor() {
        inject(DestroyRef).onDestroy(() => this.endDrag());

        effect((onCleanup) => {
            const ref = this.popover();
            if (!ref) {
                return;
            }
            const element = ref.nativeElement;
            const place = (event?: Event): void => {
                if (event?.target instanceof Node && element.contains(event.target)) {
                    return;
                }
                this.place(element);
            };
            const onKey = (event: KeyboardEvent): void => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    event.preventDefault();
                    this.close(true);
                }
            };
            const onPointerDown = (event: PointerEvent): void => {
                const target = event.target as Node | null;
                if (target && !element.contains(target) && !this.trigger()?.nativeElement.contains(target)) {
                    this.close(false);
                }
            };

            untracked(() => {
                document.body.appendChild(element);
                element.style.position = 'fixed';
                element.style.zIndex = String(POPOVER_Z_INDEX);
                this.place(element);
                this.square()?.nativeElement.focus();
            });

            window.addEventListener('resize', place);
            window.addEventListener('scroll', place, true);
            document.addEventListener('keydown', onKey, true);
            document.addEventListener('pointerdown', onPointerDown, true);
            onCleanup(() => {
                window.removeEventListener('resize', place);
                window.removeEventListener('scroll', place, true);
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('pointerdown', onPointerDown, true);
                this.endDrag();
                element.remove();
            });
        });
    }

    toggle(): void {
        if (this.open()) {
            this.close(false);
            return;
        }
        this.setHsv(hexToHsv(this.color() ?? this.fallback()), false);
        this.open.set(true);
    }

    close(restoreFocus: boolean): void {
        this.endDrag();
        this.open.set(false);
        if (restoreFocus) {
            this.trigger()?.nativeElement.focus();
        }
    }

    startDrag(event: PointerEvent, kind: 'square' | 'hue'): void {
        const element = event.currentTarget as HTMLElement;
        this.endDrag();
        try {
            element.setPointerCapture(event.pointerId);
        } catch {
            // A synthetic event or a pointer already gone: dragging still works without capture.
        }
        this.dragTarget = { element, pointerId: event.pointerId, kind };
        element.focus();
        this.dragTo(event);
    }

    dragTo(event: PointerEvent): void {
        const drag = this.dragTarget;
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }
        const rect = drag.element.getBoundingClientRect();
        const x = clamp01(rect.width ? (event.clientX - rect.left) / rect.width : 0);
        const y = clamp01(rect.height ? (event.clientY - rect.top) / rect.height : 0);
        const current = this.hsv();
        this.setHsv(drag.kind === 'square' ? { ...current, s: x, v: 1 - y } : { ...current, h: x * 360 }, true);
    }

    /** The single exit for a drag: up, cancel, lost capture, close and destroy all land here. */
    endDrag(): void {
        const drag = this.dragTarget;
        this.dragTarget = null;
        if (drag) {
            try {
                drag.element.releasePointerCapture(drag.pointerId);
            } catch {
                // Already released.
            }
        }
    }

    squareKey(event: KeyboardEvent): void {
        const step = event.shiftKey ? 0.1 : 0.02;
        const { s, v } = this.hsv();
        let next: Partial<Hsv> | null = null;
        switch (event.key) {
            case 'ArrowLeft':
                next = { s: clamp01(s - step) };
                break;
            case 'ArrowRight':
                next = { s: clamp01(s + step) };
                break;
            case 'ArrowUp':
                next = { v: clamp01(v + step) };
                break;
            case 'ArrowDown':
                next = { v: clamp01(v - step) };
                break;
        }
        if (next) {
            event.preventDefault();
            this.setHsv({ ...this.hsv(), ...next }, true);
        }
    }

    hueKey(event: KeyboardEvent): void {
        const step = event.shiftKey ? 10 : 1;
        let delta = 0;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            delta = -step;
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            delta = step;
        }
        if (delta) {
            event.preventDefault();
            this.setHsv({ ...this.hsv(), h: Math.min(360, Math.max(0, this.hsv().h + delta)) }, true);
        }
    }

    onHexInput(raw: string): void {
        this.draft.set(raw);
        const hex = normalizeHex(raw);
        this.draftInvalid.set(!hex && raw.trim() !== '');
        if (hex) {
            this.setHsv(hexToHsv(hex), true);
        }
    }

    onHexBlur(): void {
        this.draft.set(hsvToHex(this.hsv()));
        this.draftInvalid.set(false);
    }

    pickSwatch(hex: string): void {
        this.setHsv(hexToHsv(hex), true);
    }

    clear(): void {
        this.cleared.emit();
        this.close(true);
    }

    hex(): string {
        return hsvToHex(this.hsv());
    }

    percent(n: number): number {
        return Math.round(n * 100);
    }

    private setHsv(hsv: Hsv, emit: boolean): void {
        this.hsv.set(hsv);
        const hex = hsvToHex(hsv);
        this.draft.set(hex);
        this.draftInvalid.set(false);
        if (emit) {
            this.colorChange.emit(hex);
        }
    }

    private place(element: HTMLElement): void {
        const anchor = this.trigger()?.nativeElement.getBoundingClientRect();
        if (!anchor) {
            return;
        }
        const size = {
            width: element.offsetWidth || FALLBACK_SIZE.width,
            height: element.offsetHeight || FALLBACK_SIZE.height,
        };
        const point = placePopover(anchor, size, { width: window.innerWidth, height: window.innerHeight });
        element.style.left = `${point.left}px`;
        element.style.top = `${point.top}px`;
    }
}
