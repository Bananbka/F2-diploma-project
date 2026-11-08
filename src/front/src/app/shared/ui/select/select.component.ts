import { NgTemplateOutlet } from '@angular/common';
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
    TemplateRef,
    untracked,
    viewChild,
} from '@angular/core';
import { Check, ChevronDown, LucideAngularModule } from 'lucide-angular';

import { placePopover } from '../emoji-field/emoji-button.component';

export interface SelectOption {
    value: string;
    label: string;
}

const POPOVER_Z_INDEX = 100;
let nextId = 0;

/**
 * A styled single-choice select: a button that looks like the app's text fields, and a listbox
 * popover in the same surface. Replaces the native `<select>`, whose open list the browser draws.
 *
 * The listbox is moved to `<body>` and positioned from the trigger's rect (clamped to the viewport,
 * flipping above when there is no room below). Escape closes only the popover; arrow keys, Home,
 * End and typeahead move the highlight; Enter or Space picks. A template can be supplied to draw
 * each option, e.g. to preview a font in its own face.
 */
@Component({
    selector: 'app-select',
    imports: [LucideAngularModule, NgTemplateOutlet],
    templateUrl: './select.component.html',
    styleUrl: './select.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectComponent {
    private readonly destroyRef = inject(DestroyRef);
    private readonly uid = `app-select-${nextId++}`;

    readonly options = input.required<readonly SelectOption[]>();
    readonly value = input<string | null>(null);
    /** The accessible name when there is no visible label. */
    readonly label = input<string | null>(null);
    readonly placeholder = input('Select…');
    readonly disabled = input(false);
    /** Draws the content of each option (and the trigger); receives the option as `$implicit`. */
    readonly optionTemplate = input<TemplateRef<{ $implicit: SelectOption }> | null>(null);

    readonly valueChange = output<string>();

    readonly open = signal(false);
    readonly active = signal(0);

    readonly checkIcon = Check;
    readonly chevronIcon = ChevronDown;

    private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
    private readonly listbox = viewChild<ElementRef<HTMLElement>>('listbox');
    private typed = '';
    private typedTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        effect((onCleanup) => {
            const ref = this.listbox();
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
                element.focus();
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
                element.remove();
            });
        });

        this.destroyRef.onDestroy(() => {
            if (this.typedTimer) {
                clearTimeout(this.typedTimer);
            }
        });
    }

    optionId(index: number): string {
        return `${this.uid}-opt-${index}`;
    }

    selected(): SelectOption | null {
        return this.options().find((o) => o.value === this.value()) ?? null;
    }

    toggle(): void {
        if (this.disabled()) {
            return;
        }
        if (this.open()) {
            this.close(false);
            return;
        }
        const index = this.options().findIndex((o) => o.value === this.value());
        this.active.set(Math.max(0, index));
        this.open.set(true);
    }

    close(restoreFocus: boolean): void {
        this.open.set(false);
        if (restoreFocus) {
            this.trigger()?.nativeElement.focus();
        }
    }

    pick(index: number): void {
        const option = this.options()[index];
        if (!option) {
            return;
        }
        if (option.value !== this.value()) {
            this.valueChange.emit(option.value);
        }
        this.close(true);
    }

    onTriggerKeydown(event: KeyboardEvent): void {
        if (this.disabled()) {
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!this.open()) {
                this.toggle();
            }
        }
    }

    onListKeydown(event: KeyboardEvent): void {
        const count = this.options().length;
        if (count === 0) {
            return;
        }
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                this.active.set(Math.min(count - 1, this.active() + 1));
                return;
            case 'ArrowUp':
                event.preventDefault();
                this.active.set(Math.max(0, this.active() - 1));
                return;
            case 'Home':
                event.preventDefault();
                this.active.set(0);
                return;
            case 'End':
                event.preventDefault();
                this.active.set(count - 1);
                return;
            case 'Enter':
            case ' ':
                event.preventDefault();
                this.pick(this.active());
                return;
            case 'Tab':
                this.close(false);
                return;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            this.typeahead(event.key);
        }
    }

    private typeahead(char: string): void {
        this.typed += char.toLowerCase();
        if (this.typedTimer) {
            clearTimeout(this.typedTimer);
        }
        this.typedTimer = setTimeout(() => (this.typed = ''), 600);
        const options = this.options();
        const start = this.typed.length === 1 ? this.active() + 1 : this.active();
        for (let i = 0; i < options.length; i++) {
            const index = (start + i) % options.length;
            if (options[index].label.toLowerCase().startsWith(this.typed)) {
                this.active.set(index);
                return;
            }
        }
    }

    private place(element: HTMLElement): void {
        const anchor = this.trigger()?.nativeElement.getBoundingClientRect();
        if (!anchor) {
            return;
        }
        element.style.minWidth = `${anchor.width}px`;
        const size = { width: element.offsetWidth || anchor.width, height: element.offsetHeight || 160 };
        // Left edges aligned (placePopover aligns right edges, so ask for the right edge of the popover).
        const point = placePopover({ top: anchor.top, bottom: anchor.bottom, right: anchor.left + size.width }, size, {
            width: window.innerWidth,
            height: window.innerHeight,
        });
        element.style.left = `${point.left}px`;
        element.style.top = `${point.top}px`;
    }
}
