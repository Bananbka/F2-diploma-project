import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { LucideAngularModule, X } from 'lucide-angular';

import {
    BackgroundImageFit,
    BackgroundImageSettings,
    DEFAULT_BACKGROUND_IMAGE,
} from '../../../../core/models/appearance.model';
import { appearanceVars } from '../../../../core/services/appearance-css';
import { AppearanceStore } from '../../../../core/services/appearance-store.service';
import { BackgroundImageService } from '../../../../core/services/background-image.service';
import { ConfirmService } from '../../../../shared/ui/confirm-dialog/confirm.service';
import { DismissOnEscapeDirective } from '../../../../shared/ui/dismiss/dismiss-on-escape.directive';
import { trapTab } from '../../../../shared/ui/focus-trap';
import { ChatBackgroundComponent } from '../../../chat/chat-background/chat-background.component';

export type TuningKey = 'position_x' | 'position_y' | 'zoom' | 'dim' | 'blur';

export const TUNING: readonly { key: TuningKey; label: string; min: number; max: number; unit: string }[] = [
    { key: 'position_x', label: 'Horizontal position', min: 0, max: 100, unit: '%' },
    { key: 'position_y', label: 'Vertical position', min: 0, max: 100, unit: '%' },
    { key: 'zoom', label: 'Zoom', min: 100, max: 300, unit: '%' },
    { key: 'dim', label: 'Dim', min: 0, max: 80, unit: '%' },
    { key: 'blur', label: 'Blur', min: 0, max: 20, unit: ' px' },
];

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/**
 * The "Edit background" dialog. Everything here edits a local draft shown live over a mock
 * conversation; Apply commits it through the store (one debounced save) and Cancel throws it away.
 * Dragging the picture inside the frame, or the arrow keys on it, move the picture's position.
 */
@Component({
    selector: 'app-background-editor',
    imports: [LucideAngularModule, ChatBackgroundComponent, DismissOnEscapeDirective],
    templateUrl: './background-editor.component.html',
    styleUrl: './background-editor.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackgroundEditorComponent {
    private readonly store = inject(AppearanceStore);
    private readonly images = inject(BackgroundImageService);
    private readonly confirm = inject(ConfirmService);
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly closed = output<void>();

    readonly tuning = TUNING;
    readonly fits: readonly { id: BackgroundImageFit; label: string }[] = [
        { id: 'cover', label: 'Cover' },
        { id: 'contain', label: 'Contain' },
        { id: 'tile', label: 'Tile' },
    ];
    readonly closeIcon = X;

    readonly draft = signal<BackgroundImageSettings>(this.initialDraft());
    readonly error = signal<string | null>(null);
    readonly busy = signal(false);

    private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
    private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
    private readonly imageColor = signal<string | null>(null);

    /** The live appearance with the draft substituted, so the mock chat shows the real colours and radius. */
    readonly previewStyle = computed(() => {
        const value = this.store.value();
        return appearanceVars(
            { ...value, background: { kind: 'image', color: null, gradient: null, image: this.draft() } },
            this.imageColor()
        );
    });
    readonly version = computed(() => this.draft().version ?? this.store.value().background_image_version);

    private drag: { pointerId: number; x: number; y: number; startX: number; startY: number } | null = null;

    constructor() {
        inject(DestroyRef).onDestroy(() => this.endDrag());

        effect((onCleanup) => {
            const version = this.version();
            this.imageColor.set(null);
            if (!version) {
                return;
            }
            let cancelled = false;
            onCleanup(() => (cancelled = true));
            void this.images.colorFor(version).then((color) => {
                if (!cancelled) {
                    this.imageColor.set(color);
                }
            });
        });

        // Focus lands inside the dialog so Tab and Escape work from the first keypress.
        effect(() => {
            this.dialog()?.nativeElement.focus();
        });
    }

    private initialDraft(): BackgroundImageSettings {
        const value = this.store.value();
        return {
            ...DEFAULT_BACKGROUND_IMAGE,
            ...(value.background.image ?? {}),
            version: value.background.image?.version ?? value.background_image_version,
        };
    }

    onKeydown(event: KeyboardEvent): void {
        trapTab(event, this.host.nativeElement);
    }

    setFit(fit: BackgroundImageFit): void {
        this.draft.update((d) => ({ ...d, fit }));
    }

    setTuning(key: TuningKey, raw: string): void {
        const spec = TUNING.find((t) => t.key === key)!;
        const n = Math.round(Number(raw));
        if (Number.isFinite(n)) {
            this.draft.update((d) => ({ ...d, [key]: clamp(n, spec.min, spec.max) }));
        }
    }

    /** Back to the defaults for fit, position, zoom, dim and blur; the picture itself stays. */
    resetTuning(): void {
        this.draft.update((d) => ({ ...DEFAULT_BACKGROUND_IMAGE, version: d.version }));
    }

    apply(): void {
        this.store.update({
            background: { kind: 'image', color: null, gradient: null, image: this.draft() },
        });
        this.closed.emit();
    }

    cancel(): void {
        this.endDrag();
        this.closed.emit();
    }

    async replace(file: File): Promise<void> {
        this.error.set(null);
        this.busy.set(true);
        try {
            const result = await this.store.uploadBackgroundImage(file);
            if (result.ok) {
                // A new picture starts from default tuning.
                this.draft.set(this.initialDraft());
            } else {
                this.error.set(result.message);
            }
        } finally {
            this.busy.set(false);
        }
    }

    onFileInput(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (file) {
            void this.replace(file);
        }
    }

    async remove(): Promise<void> {
        const ok = await this.confirm.ask({
            title: 'Remove background image?',
            message: 'The picture is deleted and the default background is used again.',
            confirmLabel: 'Remove',
            danger: true,
        });
        if (ok && (await this.store.removeBackgroundImage())) {
            this.closed.emit();
        }
    }

    // --- dragging the picture inside the frame ---------------------------------------------------

    startDrag(event: PointerEvent): void {
        const frame = this.frame()?.nativeElement;
        if (!frame) {
            return;
        }
        this.endDrag();
        try {
            frame.setPointerCapture(event.pointerId);
        } catch {
            // A synthetic pointer or one already gone: dragging still works without capture.
        }
        const { position_x, position_y } = this.draft();
        this.drag = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: position_x,
            startY: position_y,
        };
    }

    dragTo(event: PointerEvent): void {
        const drag = this.drag;
        const frame = this.frame()?.nativeElement;
        if (!drag || !frame || event.pointerId !== drag.pointerId) {
            return;
        }
        const rect = frame.getBoundingClientRect();
        // Dragging the picture right reveals more of its left side, so the position moves the other way.
        const dx = rect.width ? ((event.clientX - drag.x) / rect.width) * 100 : 0;
        const dy = rect.height ? ((event.clientY - drag.y) / rect.height) * 100 : 0;
        this.draft.update((d) => ({
            ...d,
            position_x: clamp(Math.round(drag.startX - dx), 0, 100),
            position_y: clamp(Math.round(drag.startY - dy), 0, 100),
        }));
    }

    /** The single exit for a drag: up, cancel, lost capture, cancel button and destroy all land here. */
    endDrag(): void {
        const drag = this.drag;
        this.drag = null;
        if (drag) {
            try {
                this.frame()?.nativeElement.releasePointerCapture(drag.pointerId);
            } catch {
                // Already released.
            }
        }
    }

    frameKey(event: KeyboardEvent): void {
        const step = event.shiftKey ? 10 : 1;
        let dx = 0;
        let dy = 0;
        switch (event.key) {
            case 'ArrowLeft':
                dx = step;
                break;
            case 'ArrowRight':
                dx = -step;
                break;
            case 'ArrowUp':
                dy = step;
                break;
            case 'ArrowDown':
                dy = -step;
                break;
            default:
                return;
        }
        event.preventDefault();
        this.draft.update((d) => ({
            ...d,
            position_x: clamp(d.position_x + dx, 0, 100),
            position_y: clamp(d.position_y + dy, 0, 100),
        }));
    }
}
