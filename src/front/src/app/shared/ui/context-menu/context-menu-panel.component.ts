import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    ElementRef,
    forwardRef,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { Check, ChevronRight, LucideAngularModule } from 'lucide-angular';

import {
    ContextMenuEntry,
    ContextMenuItem,
    isSeparator,
    MenuAnchor,
    placeAtPoint,
    placeBeside,
} from './context-menu.model';

/** How long a submenu survives the pointer leaving its parent item for a neighbouring one. */
export const SUBMENU_CLOSE_DELAY_MS = 250;

export type PanelFocus = 'first' | 'container' | 'none';

interface ParentRect {
    left: number;
    right: number;
    top: number;
}

interface Row {
    /** Position among the focusable items only (separators do not count); -1 for a separator. */
    index: number;
    item: ContextMenuItem | null;
}

/**
 * One list of entries — the root menu, or a submenu rendered recursively inside it.
 *
 * Owns positioning, roving focus and keyboard handling for its own level. Closing the whole menu is
 * the root's job (`ContextMenuComponent`); this component only reports what was chosen.
 *
 * Enter and Space are deliberately not handled: items are real buttons, so the browser turns them
 * into a click, and a second code path would fire the action twice.
 */
@Component({
    selector: 'app-context-menu-panel',
    imports: [LucideAngularModule, forwardRef(() => ContextMenuPanelComponent)],
    templateUrl: './context-menu-panel.component.html',
    styleUrl: './context-menu-panel.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextMenuPanelComponent {
    readonly items = input.required<readonly ContextMenuEntry[]>();
    /** Open at this point (root menu)... */
    readonly anchor = input<MenuAnchor | null>(null);
    /** ...or beside this parent item's rectangle (submenu). */
    readonly beside = input<ParentRect | null>(null);
    readonly level = input(0);
    readonly label = input<string | null>(null);
    readonly autoFocus = input<PanelFocus>('none');

    readonly activated = output<ContextMenuItem>();
    /** ArrowLeft or Escape inside a submenu: close just this level. */
    readonly back = output<void>();
    /** The pointer entered this panel; a parent uses it to cancel a pending submenu close. */
    readonly pointerEntered = output<void>();
    /** Escape or Tab at the root: close everything. */
    readonly dismiss = output<'escape' | 'tab'>();

    readonly chevronIcon = ChevronRight;
    readonly checkIcon = Check;

    private readonly menu = viewChild.required<ElementRef<HTMLElement>>('menu');

    readonly openSub = signal<number | null>(null);
    readonly subRect = signal<ParentRect | null>(null);
    readonly subFocus = signal<PanelFocus>('none');

    readonly rows = computed<Row[]>(() => {
        let index = 0;
        return this.items().map((entry) =>
            isSeparator(entry) ? { index: -1, item: null } : { index: index++, item: entry }
        );
    });

    private readonly measured = signal<MenuAnchor | null>(null);

    /** Where the panel is drawn: the raw anchor until measured, then the clamped/flipped result. */
    readonly position = computed<MenuAnchor>(() => {
        const measured = this.measured();
        if (measured) {
            return measured;
        }
        const beside = this.beside();
        if (beside) {
            return { x: beside.right - 4, y: beside.top - 8 };
        }
        return this.anchor() ?? { x: 0, y: 0 };
    });

    private closeTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        inject(DestroyRef).onDestroy(() => this.cancelPendingClose());

        afterNextRender(() => {
            const element = this.menu().nativeElement;
            const { width, height } = element.getBoundingClientRect();
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            const beside = this.beside();
            const placed = beside
                ? placeBeside(beside, { width, height }, viewport)
                : placeAtPoint(this.anchor() ?? { x: 0, y: 0 }, { width, height }, viewport);

            // Written straight to the element as well as to the signal: the signal only reaches the
            // DOM on the next change-detection pass, which can be after the first paint, and the
            // menu would flash at its unclamped position.
            element.style.left = `${placed.x}px`;
            element.style.top = `${placed.y}px`;
            this.measured.set(placed);

            switch (this.autoFocus()) {
                case 'first':
                    this.focusAt(this.firstEnabledOrAny(), false);
                    break;
                case 'container':
                    element.focus({ preventScroll: true });
                    break;
            }
        });
    }

    roleOf(item: ContextMenuItem): string {
        if (item.role) {
            return item.role;
        }
        return item.checked === undefined ? 'menuitem' : 'menuitemcheckbox';
    }

    private buttons(): HTMLButtonElement[] {
        // `:scope >` so a submenu rendered inside this one is not counted among its own items.
        return [...this.menu().nativeElement.querySelectorAll<HTMLButtonElement>(':scope > .item')];
    }

    private itemAt(index: number): ContextMenuItem | undefined {
        return this.rows().find((row) => row.index === index)?.item ?? undefined;
    }

    private firstEnabledOrAny(): number {
        const first = this.rows().find((row) => row.item && !row.item.disabled);
        return first?.index ?? 0;
    }

    private focusAt(index: number, closeSub = true): void {
        const button = this.buttons()[index];
        if (!button) {
            return;
        }
        if (closeSub && this.openSub() !== null && this.openSub() !== index) {
            this.closeSub(false);
        }
        button.focus({ preventScroll: true });
    }

    private currentIndex(): number {
        const active = document.activeElement;
        return this.buttons().findIndex((button) => button === active);
    }

    onHover(index: number, event: MouseEvent): void {
        const item = this.itemAt(index);
        if (!item) {
            return;
        }
        const button = event.currentTarget as HTMLElement;
        // Focus follows the pointer so keyboard navigation continues from where the mouse is.
        button.focus({ preventScroll: true });

        if (item.children && !item.disabled) {
            this.cancelPendingClose();
            this.openSubmenu(index, button, 'none');
        } else if (this.openSub() !== null && this.closeTimer === null) {
            // Not closed at once: a diagonal move toward the submenu crosses the items below the
            // parent, and closing on the first of them would make the submenu impossible to reach.
            this.closeTimer = setTimeout(() => {
                this.closeTimer = null;
                this.closeSub(false);
            }, SUBMENU_CLOSE_DELAY_MS);
        }
    }

    cancelPendingClose(): void {
        if (this.closeTimer !== null) {
            clearTimeout(this.closeTimer);
            this.closeTimer = null;
        }
    }

    activate(index: number, event: MouseEvent): void {
        const item = this.itemAt(index);
        if (!item) {
            return;
        }
        if (item.disabled) {
            event.preventDefault();
            return;
        }
        if (item.children) {
            // `detail` is 0 for a click synthesised from Enter or Space: that is the keyboard
            // path, so focus goes into the submenu instead of staying on its parent.
            this.openSubmenu(index, event.currentTarget as HTMLElement, event.detail === 0 ? 'first' : 'none');
            return;
        }
        this.activated.emit(item);
    }

    private openSubmenu(index: number, button: HTMLElement, focus: PanelFocus): void {
        if (this.openSub() === index && focus === 'none') {
            return;
        }
        const rect = button.getBoundingClientRect();
        this.subRect.set({ left: rect.left, right: rect.right, top: rect.top });
        this.subFocus.set(focus);
        this.openSub.set(index);
    }

    closeSub(refocusParent = true): void {
        this.cancelPendingClose();
        const index = this.openSub();
        this.openSub.set(null);
        this.subRect.set(null);
        this.subFocus.set('none');
        if (refocusParent && index !== null) {
            this.buttons()[index]?.focus({ preventScroll: true });
        }
    }

    onKeydown(event: KeyboardEvent): void {
        // A nested panel is a DOM descendant of this one, so every key it did not stop would also be
        // handled here. Stopping them all keeps each level responsible for its own keys only.
        event.stopPropagation();

        const count = this.buttons().length;
        const current = this.currentIndex();

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                this.focusAt(current < 0 ? 0 : (current + 1) % count);
                return;
            case 'ArrowUp':
                event.preventDefault();
                this.focusAt(current < 0 ? count - 1 : (current - 1 + count) % count);
                return;
            case 'Home':
                event.preventDefault();
                this.focusAt(0);
                return;
            case 'End':
                event.preventDefault();
                this.focusAt(count - 1);
                return;
            case 'ArrowRight': {
                const item = this.itemAt(current);
                if (item?.children && !item.disabled) {
                    event.preventDefault();
                    this.openSubmenu(current, this.buttons()[current], 'first');
                }
                return;
            }
            case 'ArrowLeft':
                if (this.level() > 0) {
                    event.preventDefault();
                    this.back.emit();
                }
                return;
            case 'Escape':
                event.preventDefault();
                if (this.level() > 0) {
                    this.back.emit();
                } else {
                    this.dismiss.emit('escape');
                }
                return;
            case 'Tab':
                event.preventDefault();
                this.dismiss.emit('tab');
                return;
        }

        // Type-ahead: a printable key jumps to the next item starting with it.
        if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const needle = event.key.toLowerCase();
            const labels = this.rows()
                .filter((row) => row.item)
                .map((row) => row.item!.label.toLowerCase());
            for (let step = 1; step <= labels.length; step++) {
                const candidate = (Math.max(current, -1) + step + labels.length) % labels.length;
                if (labels[candidate].startsWith(needle)) {
                    event.preventDefault();
                    this.focusAt(candidate);
                    return;
                }
            }
        }
    }
}
