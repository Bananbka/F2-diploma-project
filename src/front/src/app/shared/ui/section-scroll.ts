/**
 * Helpers for a single scrolling list made of `[data-section="<key>"]` blocks, with a bar of icons
 * that jumps to a section and highlights the one in view (the emoji and sticker pickers).
 *
 * Plain scroll-position maths rather than an IntersectionObserver: a section is "in view" once its
 * top has reached the top of the list, which is exactly the one whose sticky title is pinned, and it
 * is trivial to exercise in a test.
 */

/** How long after a programmatic jump the scroll spy stays quiet, so the highlight does not flicker through the sections it passes. */
export const JUMP_SETTLE_MS = 600;

/** The key of the last section whose top has scrolled up to the top edge of the list, or null if there are none. */
export function activeSectionKey(container: HTMLElement): string | null {
    let active: string | null = null;
    for (const section of Array.from(container.querySelectorAll<HTMLElement>('[data-section]'))) {
        if (section.offsetTop - container.scrollTop <= 8) {
            active = section.dataset['section'] ?? null;
        } else {
            break;
        }
    }
    return active;
}

/** Scroll the list so a section starts at its top edge, smoothly unless the user prefers reduced motion. */
export function scrollToSection(container: HTMLElement, key: string): boolean {
    const section = container.querySelector<HTMLElement>(`[data-section="${key}"]`);
    if (!section) {
        return false;
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    container.scrollTo({ top: section.offsetTop, behavior: reduce ? 'auto' : 'smooth' });
    return true;
}
