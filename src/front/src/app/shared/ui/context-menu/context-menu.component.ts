import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
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
import { LucideAngularModule, LucideIconData } from 'lucide-angular';

export interface ContextMenuItem {
    icon: LucideIconData;
    label: string;
    action: () => void;
    /** Destructive actions are set apart so they are not clicked by muscle memory. */
    danger?: boolean;
}

/** Where the menu was asked for, in viewport coordinates. */
export interface MenuAnchor {
    x: number;
    y: number;
}

const EDGE_GAP = 8;

/**
 * A right-click menu, positioned at the pointer.
 *
 * Fixed-position rather than absolute: the message list is a scroll container with
 * `overflow: hidden` ancestors, and an absolutely-positioned menu would be clipped by them.
 */
@Component({
    selector: 'app-context-menu',
    imports: [LucideAngularModule],
    template: `
        <div
            #menu
            class="menu"
            role="menu"
            [style.left.px]="left()"
            [style.top.px]="top()"
        >
            @for (item of items(); track item.label) {
                <button
                    type="button"
                    role="menuitem"
                    class="item"
                    [class.is-danger]="item.danger"
                    (click)="choose(item)"
                >
                    <span class="item-icon">
                        <lucide-icon [img]="item.icon" />
                    </span>
                    <span class="item-label">{{ item.label }}</span>
                </button>
            }
        </div>
    `,
    styles: `
        .menu {
            position: fixed;
            z-index: 90;
            min-width: 12.5rem;
            padding: 0.5rem 0;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            /* The primary-tinted glow is from the design — it lifts the menu off a dark surface
               where a plain black shadow would be invisible. */
            box-shadow:
                0 8px 32px rgb(163 88 249 / 20%),
                0 2px 8px rgb(0 0 0 / 60%);
        }

        .item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            width: 100%;
            padding: 0.625rem 1rem;
            background: none;
            border: none;
            color: var(--foreground);
            font-size: 0.875rem;
            text-align: left;
            transition: background-color 0.12s ease;

            &:hover,
            &:focus-visible {
                background: rgb(163 88 249 / 20%);
                outline: none;
            }

            &.is-danger {
                color: var(--danger);

                &:hover,
                &:focus-visible {
                    background: rgb(239 68 68 / 12%);
                }
            }
        }

        .item-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 1.25rem;
            height: 1.25rem;

            lucide-icon {
                width: 1rem;
                height: 1rem;
            }
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextMenuComponent {
    private readonly destroyRef = inject(DestroyRef);

    readonly items = input.required<ContextMenuItem[]>();
    readonly anchor = input.required<MenuAnchor>();
    readonly closed = output<void>();

    private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

    /**
     * Position, as signals bound in the template.
     *
     * Required inputs cannot be read in a constructor — doing so throws NG0950 before the component
     * renders at all, which is how an earlier version of this managed to never appear. So the anchor
     * is picked up in an effect, and corrected once measured.
     */
    private readonly offset = signal<MenuAnchor | null>(null);

    readonly left = computed(() => this.offset()?.x ?? this.anchor().x);
    readonly top = computed(() => this.offset()?.y ?? this.anchor().y);

    constructor() {
        // Re-measure whenever the anchor moves, so reusing one instance for a second message works.
        effect(() => {
            this.anchor();
            untracked(() => this.offset.set(null));
        });

        afterNextRender(() => {
            this.keepOnScreen();
            // Focus the first item so the keyboard path works — the Menu key and Shift+F10 both fire
            // `contextmenu`, so this menu is reachable without a mouse and must be usable that way.
            this.menu()?.nativeElement.querySelector<HTMLButtonElement>('.item')?.focus();
        });

        const onPointerDown = (event: MouseEvent) => {
            if (!this.menu()?.nativeElement.contains(event.target as Node)) {
                this.closed.emit();
            }
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                this.closed.emit();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                this.moveFocus(event.key === 'ArrowDown' ? 1 : -1);
            }
        };

        // Capture phase: a click on something that itself opens a menu should close this one first.
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);

        this.destroyRef.onDestroy(() => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
        });
    }

    /** Flip the menu back inside the viewport when opened near an edge. */
    private keepOnScreen(): void {
        const element = this.menu()?.nativeElement;
        if (!element) {
            return;
        }

        const { width, height } = element.getBoundingClientRect();
        const anchor = this.anchor();

        this.offset.set({
            x: Math.max(EDGE_GAP, Math.min(anchor.x, window.innerWidth - width - EDGE_GAP)),
            y: Math.max(EDGE_GAP, Math.min(anchor.y, window.innerHeight - height - EDGE_GAP)),
        });
    }

    private moveFocus(step: number): void {
        const buttons = [...(this.menu()?.nativeElement.querySelectorAll<HTMLButtonElement>('.item') ?? [])];
        if (buttons.length === 0) {
            return;
        }

        const current = buttons.findIndex((button) => button === document.activeElement);
        const next = (current + step + buttons.length) % buttons.length;
        buttons[next].focus();
    }

    choose(item: ContextMenuItem): void {
        item.action();
        this.closed.emit();
    }
}
