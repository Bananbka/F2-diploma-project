import { DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';

import { ContextMenuEntry, MenuAnchor, MenuSource } from './context-menu.model';
import { ContextMenuService } from './context-menu.service';

/** Builds the entries when the menu is asked for, so they always reflect the state of that moment. */
export type ContextMenuProvider = () => readonly ContextMenuEntry[];

export const LONG_PRESS_MS = 500;
/** A finger that travels further than this is scrolling, not pressing. */
const LONG_PRESS_SLOP_PX = 10;
/** The same gesture can surface as both a long press and a `contextmenu` event; the first wins. */
const DEDUPE_MS = 700;

const NATIVE_TARGETS = 'input, textarea, select, a[href], [contenteditable=""], [contenteditable="true"]';

/**
 * Attach a custom menu to an element.
 *
 * `[appContextMenu]` takes a function returning the entries. If it returns nothing there is no menu
 * and the browser's own is left alone, so a directive can be present on rows that sometimes have no
 * actions. Three triggers: right-click, the Menu key / Shift+F10 on the focused host, and a 500 ms
 * touch press that is abandoned if the finger moves.
 *
 * The native menu is deliberately kept where it is the useful one: on text fields and links inside
 * the host, and over selected text, because copy/paste/spell-check/"open link" belong to the browser.
 * A menu on a nested element takes precedence over one on an ancestor.
 */
@Directive({
    selector: '[appContextMenu]',
    host: {
        '(contextmenu)': 'onContextMenu($event)',
        '(keydown)': 'onKeydown($event)',
        '(focusin)': 'onFocusIn($event)',
        '(pointerdown)': 'onPointerDown($event)',
        '(pointermove)': 'onPointerMove($event)',
        '(pointerup)': 'cancelPress()',
        '(pointercancel)': 'cancelPress()',
        '(pointerleave)': 'cancelPress()',
    },
})
export class ContextMenuDirective {
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
    private readonly service = inject(ContextMenuService);

    readonly appContextMenu = input.required<ContextMenuProvider | null>();
    readonly appContextMenuDisabled = input(false);

    private pressTimer: ReturnType<typeof setTimeout> | null = null;
    private pressOrigin: MenuAnchor | null = null;
    private swallowClick = false;
    private swallowTimer: ReturnType<typeof setTimeout> | null = null;
    private lastOpenedAt = -Infinity;

    constructor() {
        // Capture phase on the host itself, so the swallow runs before the host's own click handler
        // (a chat row's `(click)` opens the chat, which a long press must not also do).
        const element = this.host.nativeElement;
        const onClick = (event: MouseEvent) => {
            if (this.swallowClick) {
                this.swallowClick = false;
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        element.addEventListener('click', onClick, true);

        // The timers are the only resources this directive holds; every other exit is a handler.
        inject(DestroyRef).onDestroy(() => {
            this.cancelPress();
            element.removeEventListener('click', onClick, true);
            if (this.swallowTimer) {
                clearTimeout(this.swallowTimer);
            }
        });
    }

    private entries(): readonly ContextMenuEntry[] {
        if (this.appContextMenuDisabled()) {
            return [];
        }
        return this.appContextMenu()?.() ?? [];
    }

    private open(anchor: MenuAnchor, source: MenuSource): boolean {
        const opened = this.service.open(this.entries(), anchor, { source, trigger: this.host.nativeElement });
        if (opened) {
            this.lastOpenedAt = Date.now();
        }
        return opened;
    }

    /** True when the browser's menu is the right one for what was clicked. */
    private wantsNativeMenu(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) {
            return false;
        }
        const native = target.closest(NATIVE_TARGETS);
        if (native && this.host.nativeElement.contains(native)) {
            return true;
        }
        const selection = window.getSelection();
        return (
            !!selection &&
            !selection.isCollapsed &&
            selection.toString().length > 0 &&
            selection.containsNode(target, true)
        );
    }

    onContextMenu(event: MouseEvent): void {
        // An inner menu already handled this event.
        if (event.defaultPrevented) {
            return;
        }
        if (this.wantsNativeMenu(event.target)) {
            return;
        }
        // Already opened a moment ago by the keyboard or long-press path for this same gesture.
        if (Date.now() - this.lastOpenedAt < DEDUPE_MS) {
            event.preventDefault();
            return;
        }
        // A keyboard-triggered `contextmenu` carries no meaningful pointer position.
        const fromKeyboard = event.clientX === 0 && event.clientY === 0 && event.detail === 0;
        const anchor = fromKeyboard ? this.hostAnchor() : { x: event.clientX, y: event.clientY };
        const source: MenuSource = this.isTouch(event) ? 'touch' : fromKeyboard ? 'keyboard' : 'mouse';

        if (this.open(anchor, source)) {
            event.preventDefault();
        }
    }

    onKeydown(event: KeyboardEvent): void {
        const isMenuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
        if (!isMenuKey || event.defaultPrevented) {
            return;
        }
        // Only for the host itself or something non-editable inside it: Shift+F10 in a text field
        // is the browser's own menu shortcut and stays that.
        const target = event.target as Element | null;
        if (target?.closest(NATIVE_TARGETS) && target !== this.host.nativeElement) {
            return;
        }
        if (this.open(this.hostAnchor(), 'keyboard')) {
            event.preventDefault();
        }
    }

    private hostAnchor(): MenuAnchor {
        const rect = this.host.nativeElement.getBoundingClientRect();
        return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + Math.min(rect.height / 2, 24) };
    }

    private isTouch(event: Event): boolean {
        const type = (event as PointerEvent).pointerType;
        return type === 'touch' || type === 'pen';
    }

    onPointerDown(event: PointerEvent): void {
        this.cancelPress();
        if (!this.isTouch(event) || event.defaultPrevented || this.wantsNativeMenu(event.target)) {
            return;
        }
        this.pressOrigin = { x: event.clientX, y: event.clientY };
        this.pressTimer = setTimeout(() => {
            const origin = this.pressOrigin;
            this.pressTimer = null;
            // Android raises `contextmenu` for the same press; if that already opened the menu,
            // opening it again would replace it a moment after it appeared.
            if (Date.now() - this.lastOpenedAt < DEDUPE_MS) {
                return;
            }
            if (origin && this.open(origin, 'touch')) {
                if (this.swallowTimer) {
                    clearTimeout(this.swallowTimer);
                }
                // The lift that ends this press would otherwise be a click on the row underneath.
                this.swallowClick = true;
                // If the finger never produces a click, do not leave the flag armed for a real one.
                this.swallowTimer = setTimeout(() => (this.swallowClick = false), 1000);
            }
        }, LONG_PRESS_MS);
    }

    /**
     * `aria-haspopup` is claimed only on the element that actually has focus, and only while the
     * provider returns something. It is evaluated on focus rather than on every change-detection
     * pass, which would rebuild every row's menu each time.
     */
    onFocusIn(event: FocusEvent): void {
        const element = this.host.nativeElement;
        if (event.target !== element) {
            return;
        }
        if (this.entries().length > 0) {
            element.setAttribute('aria-haspopup', 'menu');
        } else {
            element.removeAttribute('aria-haspopup');
        }
    }

    onPointerMove(event: PointerEvent): void {
        const origin = this.pressOrigin;
        if (
            this.pressTimer &&
            origin &&
            Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > LONG_PRESS_SLOP_PX
        ) {
            this.cancelPress();
        }
    }

    cancelPress(): void {
        if (this.pressTimer) {
            clearTimeout(this.pressTimer);
        }
        this.pressTimer = null;
        this.pressOrigin = null;
    }
}
