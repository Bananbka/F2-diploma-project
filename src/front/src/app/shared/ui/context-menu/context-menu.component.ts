import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, input, output } from '@angular/core';

import { ContextMenuEntry, ContextMenuItem, MenuAnchor, MenuCloseReason, MenuSource } from './context-menu.model';
import { ContextMenuPanelComponent, PanelFocus } from './context-menu-panel.component';

export type { ContextMenuEntry, ContextMenuItem, MenuAnchor, MenuCloseReason, MenuSource };

/** A touch menu opens under the finger that is about to lift; a click in this window is that finger. */
const TOUCH_ARM_MS = 400;

/**
 * The root of an open menu: a panel plus every way of dismissing it.
 *
 * Fixed-position rather than absolute: the message list is a scroll container with `overflow:
 * hidden` ancestors, and an absolutely-positioned menu would be clipped by them.
 *
 * All document listeners are registered here and released in one `DestroyRef` callback, so every
 * exit path — choosing, Escape, an outside click, a scroll, the host tearing the menu down — ends
 * the same way and none can leave a listener behind.
 */
@Component({
    selector: 'app-context-menu',
    imports: [ContextMenuPanelComponent],
    template: `
        <app-context-menu-panel
            [items]="items()"
            [anchor]="anchor()"
            [autoFocus]="initialFocus()"
            (activated)="choose($event)"
            (dismiss)="closed.emit($event)"
        />
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextMenuComponent {
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly items = input.required<readonly ContextMenuEntry[]>();
    readonly anchor = input.required<MenuAnchor>();
    readonly source = input<MenuSource>('mouse');
    /** The element the menu hangs off; only a scroll that moves it should dismiss the menu. */
    readonly trigger = input<HTMLElement | null>(null);
    readonly closed = output<MenuCloseReason>();

    private readonly openedAt = Date.now();

    constructor() {
        const inside = (target: EventTarget | null): boolean =>
            target instanceof Node && this.host.nativeElement.contains(target);

        // Capture phase: a click on something that itself opens a menu closes this one first.
        const onPointerDown = (event: PointerEvent) => {
            if (!inside(event.target)) {
                this.closed.emit('outside');
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            // Reached only when focus is not inside the menu (the panel stops its own keys).
            if (event.key === 'Escape') {
                this.closed.emit('escape');
            }
        };
        const onScroll = (event: Event) => {
            const target = event.target;
            if (inside(target)) {
                return;
            }
            // A scroll that cannot move the anchor (a sibling list, say) is none of the menu's
            // business. Without a known trigger, any scroll closes: the safe default.
            const trigger = this.trigger();
            const moves = !trigger || target === document || (target instanceof Node && target.contains(trigger));
            if (moves) {
                this.closed.emit('scroll');
            }
        };
        const openedWidth = window.innerWidth;
        // A soft keyboard resizes the height only; a menu should survive that, not a real width change.
        const onResize = () => {
            if (window.innerWidth !== openedWidth) {
                this.closed.emit('resize');
            }
        };

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('resize', onResize);

        inject(DestroyRef).onDestroy(() => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('scroll', onScroll, { capture: true });
            window.removeEventListener('resize', onResize);
        });
    }

    initialFocus(): PanelFocus {
        return this.source() === 'keyboard' ? 'first' : 'container';
    }

    choose(item: ContextMenuItem): void {
        if (this.source() === 'touch' && Date.now() - this.openedAt < TOUCH_ARM_MS) {
            return;
        }
        // Closed before the action runs, so an action that opens a dialog or moves focus is not
        // fought by the menu handing focus back to its trigger afterwards.
        this.closed.emit('action');
        item.action?.();
    }
}
