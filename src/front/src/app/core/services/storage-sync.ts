import { DestroyRef, inject } from '@angular/core';

/**
 * Call `onChange` whenever another tab of this origin writes `key`, or clears storage outright
 * (`event.key === null`, i.e. `localStorage.clear()`). The event is never delivered to the tab that
 * wrote, so this only ever reports other tabs' changes.
 *
 * Call it from a constructor (an injection context): the listener is removed when the owning
 * injector is destroyed. Guarded for SSR, and for specs that construct a service with `new` outside
 * any injector — such an instance's listener simply lives as long as the page.
 */
export function bindStorageKey(key: string, onChange: (event: StorageEvent) => void): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return;
    }
    const listener = (event: StorageEvent): void => {
        if (event.key === key || event.key === null) {
            onChange(event);
        }
    };
    window.addEventListener('storage', listener);
    try {
        inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', listener));
    } catch {
        // Constructed outside an injection context: nothing owns this instance's lifetime.
    }
}
