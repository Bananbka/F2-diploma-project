import { LucideIconData } from 'lucide-angular';

export interface ContextMenuItem {
    label: string;
    icon?: LucideIconData;
    /** Not called for an item that has `children`; opening the submenu is its action. */
    action?: () => void;
    /** Destructive actions are set apart so they are not clicked by muscle memory. */
    danger?: boolean;
    /** Shown but inert. Give `disabledReason` so the user can tell why. */
    disabled?: boolean;
    /** Tooltip (and screen-reader description) explaining a disabled item. */
    disabledReason?: string;
    /**
     * Makes the item a toggle: `true`/`false` renders a check slot and switches the role to
     * `menuitemcheckbox` (or `menuitemradio` when `role` says so). Leave undefined for plain items.
     */
    checked?: boolean;
    role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
    /** A submenu. Hover, click, Enter and ArrowRight open it; ArrowLeft and Escape return. */
    children?: ContextMenuEntry[];
}

export interface ContextMenuSeparator {
    separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

/** Where the menu was asked for, in viewport coordinates. */
export interface MenuAnchor {
    x: number;
    y: number;
}

/** How the menu was summoned. Touch gets a short guard against the finger lifting onto an item. */
export type MenuSource = 'mouse' | 'keyboard' | 'touch';

/** Why a menu went away, which decides whether focus goes back to the trigger. */
export type MenuCloseReason = 'action' | 'escape' | 'tab' | 'outside' | 'scroll' | 'resize' | 'route' | 'replaced';

export function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
    return 'separator' in entry;
}

/** Drops separators that would sit at the ends or next to each other, so callers can add them freely. */
export function tidyEntries(entries: readonly ContextMenuEntry[]): ContextMenuEntry[] {
    const out: ContextMenuEntry[] = [];
    for (const entry of entries) {
        if (isSeparator(entry) && (out.length === 0 || isSeparator(out[out.length - 1]))) {
            continue;
        }
        out.push(entry);
    }
    while (out.length > 0 && isSeparator(out[out.length - 1])) {
        out.pop();
    }
    return out;
}

export interface Size {
    width: number;
    height: number;
}

export const EDGE_GAP = 8;

/** Open at a point: flip to the other side of it when the menu would run off, then clamp. */
export function placeAtPoint(anchor: MenuAnchor, size: Size, viewport: Size): MenuAnchor {
    let x = anchor.x;
    let y = anchor.y;
    if (x + size.width > viewport.width - EDGE_GAP) {
        x = anchor.x - size.width;
    }
    if (y + size.height > viewport.height - EDGE_GAP) {
        y = anchor.y - size.height;
    }
    return {
        x: Math.max(EDGE_GAP, Math.min(x, viewport.width - size.width - EDGE_GAP)),
        y: Math.max(EDGE_GAP, Math.min(y, viewport.height - size.height - EDGE_GAP)),
    };
}

/** Open beside a parent item (submenu): to its right, or to its left when there is no room. */
export function placeBeside(
    parent: { left: number; right: number; top: number },
    size: Size,
    viewport: Size
): MenuAnchor {
    let x = parent.right - 4;
    if (x + size.width > viewport.width - EDGE_GAP) {
        x = parent.left - size.width + 4;
    }
    const y = parent.top - 8;
    return {
        x: Math.max(EDGE_GAP, x),
        y: Math.max(EDGE_GAP, Math.min(y, viewport.height - size.height - EDGE_GAP)),
    };
}
