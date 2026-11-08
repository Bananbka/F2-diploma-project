import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    signal,
    viewChild,
} from '@angular/core';
import { ChevronLeft, ChevronRight, Download, LucideAngularModule, Minus, Plus, X } from 'lucide-angular';

import { DismissOnEscapeDirective } from '../../../shared/ui/dismiss/dismiss-on-escape.directive';
import { trapTab } from '../../../shared/ui/focus-trap';
import { canHaveAlpha, MediaViewerService } from './media-viewer.service';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
const ZOOM_STEP = 0.5;

const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * Full-screen viewer for the pictures in a chat. Shows the blob a bubble already decrypted, with
 * zoom (wheel, double-click, +/- and keys), drag-to-pan while zoomed, previous/next through the
 * chat's media, and a download of the original file. Escape goes through the dismiss stack.
 */
@Component({
    selector: 'app-media-viewer',
    imports: [LucideAngularModule, DismissOnEscapeDirective],
    templateUrl: './media-viewer.component.html',
    styleUrl: './media-viewer.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaViewerComponent {
    protected readonly viewer = inject(MediaViewerService);
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly item = this.viewer.item;
    readonly count = computed(() => this.viewer.items().length);
    readonly position = computed(() => this.viewer.index() + 1);
    readonly hasPrev = computed(() => this.viewer.index() > 0);
    readonly hasNext = computed(() => this.viewer.index() < this.count() - 1);
    readonly alpha = computed(() => canHaveAlpha(this.item()?.contentType ?? ''));

    readonly zoom = signal(1);
    readonly panX = signal(0);
    readonly panY = signal(0);
    readonly transform = computed(() => `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`);

    readonly closeIcon = X;
    readonly prevIcon = ChevronLeft;
    readonly nextIcon = ChevronRight;
    readonly plusIcon = Plus;
    readonly minusIcon = Minus;
    readonly downloadIcon = Download;

    private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
    private drag: { id: number; x: number; y: number; px: number; py: number } | null = null;

    constructor() {
        afterNextRender(() => this.dialog().nativeElement.focus());
        // A different picture starts fitted.
        effect(() => {
            this.item();
            this.resetView();
        });
    }

    resetView(): void {
        this.zoom.set(1);
        this.panX.set(0);
        this.panY.set(0);
    }

    setZoom(value: number): void {
        const next = clampZoom(value);
        this.zoom.set(next);
        if (next === 1) {
            this.panX.set(0);
            this.panY.set(0);
        }
    }

    zoomIn(): void {
        this.setZoom(this.zoom() + ZOOM_STEP);
    }

    zoomOut(): void {
        this.setZoom(this.zoom() - ZOOM_STEP);
    }

    onWheel(event: WheelEvent): void {
        event.preventDefault();
        this.setZoom(this.zoom() + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }

    toggleZoom(): void {
        this.setZoom(this.zoom() > 1 ? 1 : 2.5);
    }

    prev(): void {
        this.viewer.step(-1);
    }

    next(): void {
        this.viewer.step(1);
    }

    close(): void {
        this.endDrag();
        this.viewer.close();
    }

    onKeydown(event: KeyboardEvent): void {
        switch (event.key) {
            case 'ArrowLeft':
                event.preventDefault();
                this.prev();
                return;
            case 'ArrowRight':
                event.preventDefault();
                this.next();
                return;
            case '+':
            case '=':
                event.preventDefault();
                this.zoomIn();
                return;
            case '-':
                event.preventDefault();
                this.zoomOut();
                return;
            case '0':
                event.preventDefault();
                this.resetView();
                return;
        }
        trapTab(event, this.host.nativeElement);
    }

    // --- pan while zoomed -------------------------------------------------------------------------

    startPan(event: PointerEvent): void {
        if (this.zoom() <= 1) {
            return;
        }
        const stage = event.currentTarget as HTMLElement;
        this.endDrag();
        try {
            stage.setPointerCapture(event.pointerId);
        } catch {
            // Synthetic pointer: panning still works without capture.
        }
        this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, px: this.panX(), py: this.panY() };
    }

    pan(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.id) {
            return;
        }
        this.panX.set(drag.px + event.clientX - drag.x);
        this.panY.set(drag.py + event.clientY - drag.y);
    }

    /** The one exit for a drag: up, cancel, lost capture, close and destroy all end here. */
    endDrag(): void {
        this.drag = null;
    }
}
