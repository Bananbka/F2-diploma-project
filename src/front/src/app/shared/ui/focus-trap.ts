const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Visible, tabbable descendants of `root`, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0
    );
}

/**
 * Keep Tab inside a modal.
 *
 * When a nested `aria-modal` layer is open inside `root` (a cropper over the settings dialog, a
 * confirmation over a form), the topmost one owns focus and the layers beneath it are unreachable.
 * Does nothing if the event was already handled by an inner layer, so two traps never both move
 * focus for one keypress.
 */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
    if (event.key !== 'Tab' || event.defaultPrevented) {
        return;
    }

    const layers = root.querySelectorAll<HTMLElement>('[aria-modal="true"]');
    const scope = layers.length > 0 ? layers[layers.length - 1] : root;
    const items = focusableWithin(scope);

    if (items.length === 0) {
        event.preventDefault();
        scope.focus();
        return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (!scope.contains(active)) {
        event.preventDefault();
        first.focus();
    } else if (event.shiftKey && (active === first || active === scope)) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
    }
}
