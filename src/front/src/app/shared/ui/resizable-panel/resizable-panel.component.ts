import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';

const STORAGE_PREFIX = 'panel-width:';

/**
 * Wraps `ng-content` in a panel whose width is user-resizable via a drag handle on its right edge,
 * and persisted to `localStorage` under `panel-width:<storageKey>`.
 *
 * A wrapper component rather than a directive: it needs to render its own handle element, which a
 * bare attribute directive cannot do.
 */
@Component({
    selector: 'app-resizable-panel',
    imports: [],
    templateUrl: './resizable-panel.component.html',
    styleUrl: './resizable-panel.component.scss',
    host: {
        '[style.width.px]': 'disabled() ? null : width()',
    },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResizablePanelComponent implements OnInit {
    private readonly destroyRef = inject(DestroyRef);

    readonly storageKey = input.required<string>();
    readonly minWidth = input(256);
    readonly maxWidth = input(512);
    readonly defaultWidth = input(320);

    /**
     * Short-circuits the inline width and hides the drag handle without tearing the component (and
     * its projected content) down — the caller toggles this instead of swapping between an `@if`
     * branch that renders this component and one that doesn't, which would destroy and recreate
     * whatever is projected into it every time the condition flips.
     */
    readonly disabled = input(false);

    readonly isDragging = signal(false);
    readonly width = signal(0);

    /** Whether a drag can currently be started — mirrors `disabled` but kept as a computed for clarity at call sites. */
    private readonly canDrag = computed(() => !this.disabled());

    private dragStartX = 0;
    private dragStartWidth = 0;

    /** Disposer for the single live `destroyRef.onDestroy` registration belonging to the in-progress drag, if any. */
    private disposeOnDestroy: (() => void) | null = null;

    /**
     * `storageKey` is a required input, which throws NG0950 if read before Angular assigns it — so
     * the initial width is picked up here rather than in the constructor (see the same constraint
     * on `ContextMenuComponent.anchor`).
     */
    ngOnInit(): void {
        this.width.set(this.readStoredWidth());
    }

    private storageFullKey(): string {
        return STORAGE_PREFIX + this.storageKey();
    }

    private clamp(value: number): number {
        return Math.min(this.maxWidth(), Math.max(this.minWidth(), value));
    }

    private readStoredWidth(): number {
        try {
            const raw = localStorage.getItem(this.storageFullKey());
            if (raw === null) {
                return this.defaultWidth();
            }
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) {
                return this.defaultWidth();
            }
            return this.clamp(parsed);
        } catch {
            return this.defaultWidth();
        }
    }

    private persistWidth(value: number): void {
        try {
            localStorage.setItem(this.storageFullKey(), String(value));
        } catch {
            // Private browsing, quota, or disabled storage — fail soft and keep the in-memory width.
        }
    }

    onHandlePointerDown(event: PointerEvent): void {
        if (this.isDragging()) {
            return;
        }

        if (!this.canDrag()) {
            return;
        }

        event.preventDefault();

        const handle = event.currentTarget as HTMLElement;
        handle.setPointerCapture(event.pointerId);

        this.dragStartX = event.clientX;
        this.dragStartWidth = this.width();
        this.isDragging.set(true);

        const previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';

        const onPointerMove = (moveEvent: PointerEvent) => {
            const delta = moveEvent.clientX - this.dragStartX;
            this.width.set(this.clamp(this.dragStartWidth + delta));
        };

        // Cleanup runs exactly once per drag, whichever of the three triggers reaches it first:
        // a normal pointerup, a pointercancel (touch gesture reinterpreted as scroll/zoom, OS
        // interrupt, stylus hover change, ...), or the component being destroyed mid-drag (e.g. the
        // narrow/wide breakpoint toggling `disabled` structurally — or, before that existed, the
        // old `@if`/`@else` swap — while the handle is held).
        const cleanup = () => {
            if (handle.hasPointerCapture(event.pointerId)) {
                handle.releasePointerCapture(event.pointerId);
            }
            this.isDragging.set(false);
            document.body.style.userSelect = previousUserSelect;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerCancel);

            if (this.disposeOnDestroy) {
                this.disposeOnDestroy();
                this.disposeOnDestroy = null;
            }
        };

        const onPointerUp = () => {
            cleanup();
            this.persistWidth(this.width());
        };

        const onPointerCancel = () => {
            cleanup();
        };

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerCancel);

        // Registered fresh per drag and disposed as soon as the drag ends normally, so a long-lived
        // panel resized many times over a session never accumulates more than one live registration.
        this.disposeOnDestroy = this.destroyRef.onDestroy(cleanup);
    }
}
