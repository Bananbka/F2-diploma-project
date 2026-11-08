/** How close to the bottom (px) still counts as "reading the newest messages". */
export const STICK_THRESHOLD_PX = 80;

/**
 * Keeps a scroll container pinned to its bottom while the reader has not scrolled away.
 *
 * Scrolling once after the rows render is not enough: stickers, images and video settle their
 * height only after they load, and placeholders are replaced by decrypted content, so the
 * content keeps growing after the scroll and the view ends up short of the newest message. This
 * instead re-scrolls whenever the content's height changes, for as long as the reader is pinned.
 */
export class StickToBottom {
    private pinned = true;
    private resizeObserver: ResizeObserver | null = null;
    private mutationObserver: MutationObserver | null = null;
    private readonly observed = new Set<Element>();
    private frame: number | null = null;

    private readonly onMediaLoad = () => this.contentChanged();

    constructor(
        private readonly element: HTMLElement,
        private readonly threshold = STICK_THRESHOLD_PX
    ) {}

    get isPinned(): boolean {
        return this.pinned;
    }

    /** Start watching for content growth. Safe to skip in environments without ResizeObserver. */
    attach(): void {
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.contentChanged());
            this.resizeObserver.observe(this.element);
            this.syncChildren();
        }
        if (typeof MutationObserver !== 'undefined') {
            this.mutationObserver = new MutationObserver(() => {
                this.syncChildren();
                this.contentChanged();
            });
            this.mutationObserver.observe(this.element, { childList: true });
        }
        // load / loadedmetadata do not bubble, so listen in the capture phase.
        this.element.addEventListener('load', this.onMediaLoad, true);
        this.element.addEventListener('loadedmetadata', this.onMediaLoad, true);
    }

    detach(): void {
        this.resizeObserver?.disconnect();
        this.mutationObserver?.disconnect();
        this.observed.clear();
        this.element.removeEventListener('load', this.onMediaLoad, true);
        this.element.removeEventListener('loadedmetadata', this.onMediaLoad, true);
        if (this.frame !== null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
    }

    /** Re-arm, as when another chat is opened. */
    reset(): void {
        this.pinned = true;
    }

    /** Stop pinning, e.g. when jumping to an older message. */
    unpin(): void {
        this.pinned = false;
    }

    /** Call from the scroll handler: pinned exactly while the reader is near the bottom. */
    onScroll(): void {
        this.pinned = this.distanceFromBottom() < this.threshold;
    }

    /** Call when rows were added or heights changed. Scrolls only while pinned. */
    contentChanged(): void {
        if (!this.pinned || this.frame !== null) {
            return;
        }
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            if (this.pinned) {
                this.scrollToBottomNow();
            }
        });
    }

    /** Synchronous variant of the above, used by tests and for an immediate snap. */
    scrollToBottomNow(): void {
        this.element.scrollTop = this.element.scrollHeight;
    }

    private distanceFromBottom(): number {
        return this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight;
    }

    /** Rows are direct children of the container, so each one is observed for its own growth. */
    private syncChildren(): void {
        if (!this.resizeObserver) {
            return;
        }
        const current = new Set<Element>(Array.from(this.element.children));
        for (const child of current) {
            if (!this.observed.has(child)) {
                this.resizeObserver.observe(child);
            }
        }
        for (const child of this.observed) {
            if (!current.has(child)) {
                this.resizeObserver.unobserve(child);
            }
        }
        this.observed.clear();
        current.forEach((child) => this.observed.add(child));
    }
}
