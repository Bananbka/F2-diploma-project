import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs';

import { ContextMenuEntry, MenuAnchor, MenuCloseReason, MenuSource, tidyEntries } from './context-menu.model';

export interface OpenMenu {
    /** Distinguishes one opening from the next so the host renders a fresh instance each time. */
    id: number;
    items: ContextMenuEntry[];
    anchor: MenuAnchor;
    source: MenuSource;
    trigger: HTMLElement | null;
}

export interface OpenMenuOptions {
    source?: MenuSource;
    /** The element focus returns to on close. Defaults to whatever had focus when the menu opened. */
    trigger?: HTMLElement | null;
}

/**
 * The one place a context menu lives.
 *
 * A single overlay host renders whatever is in `current`, so opening a second menu replaces the
 * first rather than stacking, and there is exactly one set of document listeners at any time.
 * Callers hand over entries and a point; they do not own any DOM.
 */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
    private nextId = 0;

    readonly current = signal<OpenMenu | null>(null);

    constructor() {
        // A navigation leaves the anchored content behind; the menu would be pointing at nothing.
        inject(Router)
            .events.pipe(
                filter((event) => event instanceof NavigationStart),
                takeUntilDestroyed(inject(DestroyRef))
            )
            .subscribe(() => this.close('route'));
    }

    /**
     * Open a menu. Returns false (and opens nothing) when there is nothing to show, so the caller
     * knows to leave the browser's own menu alone.
     */
    open(entries: readonly ContextMenuEntry[], anchor: MenuAnchor, options: OpenMenuOptions = {}): boolean {
        const items = tidyEntries(entries);
        if (!items.some((entry) => !('separator' in entry))) {
            return false;
        }

        const previous = this.current();
        const active = document.activeElement;
        this.current.set({
            id: this.nextId++,
            items,
            anchor,
            source: options.source ?? 'mouse',
            // When replacing a menu, keep its original trigger: focus at this moment is inside the
            // outgoing menu, and returning there on close would land on a destroyed element.
            trigger:
                options.trigger ??
                previous?.trigger ??
                (active instanceof HTMLElement && active !== document.body ? active : null),
        });
        return true;
    }

    close(reason: MenuCloseReason = 'action'): void {
        const menu = this.current();
        if (!menu) {
            return;
        }
        this.current.set(null);

        // A click elsewhere has already moved focus to what was clicked; pulling it back would undo
        // the user's own choice. Scroll and resize leave focus alone for the same reason.
        const restore = reason === 'action' || reason === 'escape' || reason === 'tab';
        if (restore && menu.trigger?.isConnected) {
            menu.trigger.focus({ preventScroll: true });
        }
    }
}
