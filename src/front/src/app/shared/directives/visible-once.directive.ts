import { Directive, ElementRef, inject, OnDestroy, output } from '@angular/core';

/**
 * Fires once when the host element first enters the viewport, then disconnects.
 *
 * Used to gate lazy attachment decryption (image/video bubbles) on actually scrolling a message
 * into view, rather than decrypting an entire long scrollback's worth of media the instant it
 * loads.
 */
@Directive({
    selector: '[appVisibleOnce]',
    standalone: true,
})
export class VisibleOnceDirective implements OnDestroy {
    private readonly element = inject(ElementRef<HTMLElement>);

    readonly visible = output<void>();

    private observer: IntersectionObserver | null = null;

    constructor() {
        this.observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                this.visible.emit();
                this.disconnect();
            }
        });
        this.observer.observe(this.element.nativeElement);
    }

    ngOnDestroy(): void {
        this.disconnect();
    }

    private disconnect(): void {
        this.observer?.disconnect();
        this.observer = null;
    }
}
