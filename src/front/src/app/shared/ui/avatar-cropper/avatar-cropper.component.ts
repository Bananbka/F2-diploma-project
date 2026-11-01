import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import { LucideAngularModule, RotateCcw, RotateCw, Undo2, ZoomIn, ZoomOut } from 'lucide-angular';

import { trapTab } from '../focus-trap';
import {
    clamp,
    CropState,
    initialState,
    MAX_ZOOM,
    MIN_ZOOM,
    panBy,
    rotate as rotateState,
    zoomTo,
} from './avatar-cropper.geometry';
import {
    AvatarImageError,
    clampOutputSize,
    decodeImage,
    OUTPUT_SIZE,
    paintCrop,
    renderAvatarFile,
} from './avatar-image';

/** Frame size before the stage has been measured. */
const DEFAULT_FRAME = 288;
const KEY_STEP = 8;
const KEY_STEP_LARGE = 32;
const KEY_ZOOM_FACTOR = 1.1;

type Status = 'loading' | 'ready' | 'error';

/**
 * Modal for placing a picture inside a circular avatar.
 *
 * Reusable: it takes a `File` and emits a cropped `File`; what happens next (upload, preview) is the
 * caller's business. Drag or arrow keys pan, wheel / pinch / slider / +/- zoom, one button rotates a
 * quarter turn, and the picture always covers the frame (see the geometry module).
 *
 * The picture is decoded to an `ImageBitmap` and drawn on a canvas rather than shown through an
 * `<img>`, so no object URL is ever created and none can leak; the only resource to release is the
 * bitmap, which `cleanup` closes on every exit path alongside the observer and pointer capture.
 */
@Component({
    selector: 'app-avatar-cropper',
    imports: [LucideAngularModule],
    templateUrl: './avatar-cropper.component.html',
    styleUrl: './avatar-cropper.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AvatarCropperComponent {
    readonly file = input.required<File>();
    readonly outputSize = input(OUTPUT_SIZE);
    readonly applied = output<File>();
    readonly cancelled = output<void>();

    private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
    private readonly stage = viewChild.required<ElementRef<HTMLElement>>('stage');
    private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

    readonly status = signal<Status>('loading');
    readonly errorText = signal<string | null>(null);
    readonly applyError = signal<string | null>(null);
    readonly applying = signal(false);
    readonly dragging = signal(false);
    readonly crop = signal<CropState>({ zoom: MIN_ZOOM, cx: 0, cy: 0, rotation: 0 });
    readonly frame = signal(DEFAULT_FRAME);

    readonly minZoom = MIN_ZOOM;
    readonly maxZoom = MAX_ZOOM;
    readonly zoomText = computed(() => `${Math.round(this.crop().zoom * 100)}%`);

    readonly zoomInIcon = ZoomIn;
    readonly zoomOutIcon = ZoomOut;
    readonly rotateLeftIcon = RotateCcw;
    readonly rotateRightIcon = RotateCw;
    readonly resetIcon = Undo2;

    private bitmap: ImageBitmap | null = null;
    private generation = 0;
    private destroyed = false;
    private observer: ResizeObserver | null = null;
    private readonly pointers = new Map<number, { x: number; y: number }>();
    private captured: { element: HTMLElement; id: number }[] = [];
    private readonly opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    constructor() {
        effect(() => {
            const file = this.file();
            untracked(() => void this.load(file));
        });

        effect(() => {
            const state = this.crop();
            const frame = this.frame();
            if (this.status() === 'ready') {
                untracked(() => this.paint(state, frame));
            }
        });

        afterNextRender(() => {
            const stage = this.stage().nativeElement;
            this.frame.set(stage.clientWidth || DEFAULT_FRAME);
            if (typeof ResizeObserver !== 'undefined') {
                this.observer = new ResizeObserver(() => this.frame.set(stage.clientWidth || DEFAULT_FRAME));
                this.observer.observe(stage);
            }
            stage.focus({ preventScroll: true });
        });

        inject(DestroyRef).onDestroy(() => this.cleanup());
    }

    // ── Loading ─────────────────────────────────────────────────────────────────────────────

    private async load(file: File): Promise<void> {
        const generation = ++this.generation;
        this.status.set('loading');
        this.errorText.set(null);
        this.applyError.set(null);
        this.releaseBitmap();

        try {
            const bitmap = await decodeImage(file);
            if (generation !== this.generation) {
                // Superseded or destroyed while decoding: nothing may keep this bitmap alive.
                bitmap.close();
                return;
            }
            this.bitmap = bitmap;
            this.crop.set(initialState(bitmap.width, bitmap.height));
            this.status.set('ready');
        } catch (error) {
            if (generation !== this.generation) {
                return;
            }
            this.errorText.set(error instanceof AvatarImageError ? error.message : 'That image could not be opened.');
            this.status.set('error');
        }
    }

    private releaseBitmap(): void {
        this.bitmap?.close();
        this.bitmap = null;
    }

    /** One teardown for every way out: cancel, apply, error, and the component being destroyed. */
    private cleanup(): void {
        this.destroyed = true;
        this.generation++;
        this.releaseBitmap();
        this.observer?.disconnect();
        this.observer = null;
        this.endPointers();
        if (this.opener?.isConnected) {
            this.opener.focus({ preventScroll: true });
        }
    }

    private paint(state: CropState, frame: number): void {
        const bitmap = this.bitmap;
        const canvas = this.canvas().nativeElement;
        const ctx = canvas.getContext('2d');
        if (!bitmap || !ctx) {
            return;
        }
        const pixels = Math.max(1, Math.round(frame * (window.devicePixelRatio || 1)));
        if (canvas.width !== pixels || canvas.height !== pixels) {
            canvas.width = pixels;
            canvas.height = pixels;
        }
        paintCrop(ctx, bitmap, state, frame, pixels);
    }

    // ── Operations ──────────────────────────────────────────────────────────────────────────

    private update(change: (state: CropState, width: number, height: number, frame: number) => CropState): void {
        const bitmap = this.bitmap;
        if (!bitmap || this.status() !== 'ready') {
            return;
        }
        this.crop.update((state) => change(state, bitmap.width, bitmap.height, this.frame()));
    }

    panBy(dx: number, dy: number): void {
        this.update((s, w, h, f) => panBy(s, dx, dy, w, h, f));
    }

    zoomBy(factor: number, anchor?: { x: number; y: number }): void {
        this.update((s, w, h, f) => zoomTo(s, s.zoom * factor, w, h, f, anchor));
    }

    setZoom(zoom: number): void {
        this.update((s, w, h, f) => zoomTo(s, zoom, w, h, f));
    }

    rotate(direction: 1 | -1): void {
        this.update((s, w, h, f) => rotateState(s, direction, w, h, f));
    }

    reset(): void {
        const bitmap = this.bitmap;
        if (bitmap) {
            this.crop.set(clamp(initialState(bitmap.width, bitmap.height), bitmap.width, bitmap.height, this.frame()));
        }
    }

    onSlider(event: Event): void {
        this.setZoom(Number((event.target as HTMLInputElement).value));
    }

    // ── Input ───────────────────────────────────────────────────────────────────────────────

    onPointerDown(event: PointerEvent): void {
        if (this.status() !== 'ready') {
            return;
        }
        const element = event.currentTarget as HTMLElement;
        try {
            element.setPointerCapture(event.pointerId);
            this.captured.push({ element, id: event.pointerId });
        } catch {
            // Synthetic or already-gone pointers cannot be captured; dragging still works without.
        }
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.dragging.set(true);
    }

    onPointerMove(event: PointerEvent): void {
        const previous = this.pointers.get(event.pointerId);
        if (!previous) {
            return;
        }
        const current = { x: event.clientX, y: event.clientY };

        if (this.pointers.size === 1) {
            this.panBy(current.x - previous.x, current.y - previous.y);
        } else if (this.pointers.size === 2) {
            const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
            if (other) {
                const before = Math.hypot(previous.x - other.x, previous.y - other.y);
                const after = Math.hypot(current.x - other.x, current.y - other.y);
                if (before > 0 && after > 0) {
                    const rect = this.stage().nativeElement.getBoundingClientRect();
                    this.zoomBy(after / before, {
                        x: (current.x + other.x) / 2 - rect.left,
                        y: (current.y + other.y) / 2 - rect.top,
                    });
                }
            }
        }
        this.pointers.set(event.pointerId, current);
    }

    onPointerEnd(event: PointerEvent): void {
        this.pointers.delete(event.pointerId);
        this.captured = this.captured.filter((c) => c.id !== event.pointerId);
        if (this.pointers.size === 0) {
            this.dragging.set(false);
        }
    }

    private endPointers(): void {
        for (const { element, id } of this.captured) {
            try {
                element.releasePointerCapture(id);
            } catch {
                // Already released by the browser.
            }
        }
        this.captured = [];
        this.pointers.clear();
    }

    onWheel(event: WheelEvent): void {
        if (this.status() !== 'ready') {
            return;
        }
        event.preventDefault();
        const rect = this.stage().nativeElement.getBoundingClientRect();
        const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
        this.zoomBy(Math.exp(-event.deltaY * lines * 0.0015), {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        });
    }

    onStageKeydown(event: KeyboardEvent): void {
        if (event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        // Arrows move the picture the way a drag in that direction would.
        const moves: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        };

        const move = moves[event.key];
        if (move) {
            event.preventDefault();
            this.panBy(move[0], move[1]);
        } else if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            this.zoomBy(KEY_ZOOM_FACTOR);
        } else if (event.key === '-' || event.key === '_') {
            event.preventDefault();
            this.zoomBy(1 / KEY_ZOOM_FACTOR);
        } else if (event.key === '0') {
            event.preventDefault();
            this.reset();
        }
    }

    onDialogKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            // Close this layer only: a settings dialog underneath must stay open.
            event.preventDefault();
            event.stopPropagation();
            this.cancel();
        } else if (event.key === 'Tab') {
            trapTab(event, this.dialog().nativeElement);
        }
    }

    // ── Outcome ─────────────────────────────────────────────────────────────────────────────

    cancel(): void {
        if (!this.applying()) {
            this.cancelled.emit();
        }
    }

    async apply(): Promise<void> {
        const bitmap = this.bitmap;
        if (this.destroyed || !bitmap || this.status() !== 'ready' || this.applying()) {
            return;
        }

        // Anything that closes or replaces the bitmap bumps this, so every await below can tell
        // whether the picture it started with is still the one on screen.
        const generation = this.generation;
        this.applying.set(true);
        this.applyError.set(null);
        try {
            const file = await renderAvatarFile(bitmap, this.crop(), this.frame(), clampOutputSize(this.outputSize()));
            if (generation === this.generation && !this.destroyed) {
                this.applied.emit(file);
            }
        } catch (error) {
            if (generation === this.generation && !this.destroyed) {
                this.applyError.set(
                    error instanceof AvatarImageError ? error.message : 'Could not prepare that image. Try again.'
                );
            }
        } finally {
            if (!this.destroyed) {
                this.applying.set(false);
            }
        }
    }
}
