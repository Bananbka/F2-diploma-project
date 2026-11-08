import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import {
    AppearanceFontFamily,
    AppearanceGradient,
    BACKGROUND_SWATCHES,
    BackgroundImageFit,
    BackgroundImageSettings,
    BUBBLE_RADIUS_MAX,
    BUBBLE_RADIUS_MIN,
    BUBBLE_SWATCHES,
    DEFAULT_BACKGROUND_IMAGE,
    FONT_FAMILIES,
    FONT_LABELS,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    FONT_STACKS,
    GRADIENT_CSS,
    GRADIENT_PRESETS,
} from '../../../core/models/appearance.model';
import { appearanceVars } from '../../../core/services/appearance-css';
import { AppearanceStore } from '../../../core/services/appearance-store.service';
import { BackgroundImageService } from '../../../core/services/background-image.service';
import { ColorPickerComponent } from '../../../shared/ui/color-picker/color-picker.component';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';
import { ChatBackgroundComponent } from '../../chat/chat-background/chat-background.component';

const DEFAULT_OWN_PICKER = '#a358f9';
const DEFAULT_OTHER_PICKER = '#1e1e26';
const DEFAULT_BG_PICKER = '#0a0a0c';

/**
 * The Appearance tab. Every control writes straight to `AppearanceStore`, which applies the change
 * everywhere at once and saves it after a pause, so the preview here and the real chat behind the
 * dialog always agree. None of the settings are required.
 */
@Component({
    selector: 'app-appearance',
    imports: [ColorPickerComponent, ChatBackgroundComponent],
    templateUrl: './appearance.component.html',
    styleUrl: './appearance.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppearanceComponent {
    private readonly store = inject(AppearanceStore);
    private readonly confirm = inject(ConfirmService);

    readonly value = this.store.value;
    private readonly images = inject(BackgroundImageService);
    private readonly imageColor = signal<string | null>(null);
    readonly previewStyle = computed(() => appearanceVars(this.value(), this.imageColor()));

    readonly radiusMin = BUBBLE_RADIUS_MIN;
    readonly radiusMax = BUBBLE_RADIUS_MAX;

    /** The tuning sliders for the background picture, in display order. */
    readonly tuning: readonly {
        key: 'position_x' | 'position_y' | 'zoom' | 'dim' | 'blur';
        label: string;
        min: number;
        max: number;
        unit: string;
    }[] = [
        { key: 'position_x', label: 'Horizontal position', min: 0, max: 100, unit: '%' },
        { key: 'position_y', label: 'Vertical position', min: 0, max: 100, unit: '%' },
        { key: 'zoom', label: 'Zoom', min: 100, max: 300, unit: '%' },
        { key: 'dim', label: 'Dim', min: 0, max: 80, unit: '%' },
        { key: 'blur', label: 'Blur', min: 0, max: 20, unit: ' px' },
    ];
    readonly fits: readonly { id: BackgroundImageFit; label: string }[] = [
        { id: 'cover', label: 'Cover' },
        { id: 'contain', label: 'Contain' },
        { id: 'tile', label: 'Tile' },
    ];

    readonly image = computed(() => this.value().background.image ?? null);
    readonly previewImage = computed(() => (this.value().background.kind === 'image' ? this.image() : null));
    readonly hasUploadedImage = computed(() => !!this.value().background_image_version);
    readonly imageError = signal<string | null>(null);
    readonly uploading = signal(false);
    readonly dragOver = signal(false);

    constructor() {
        effect((onCleanup) => {
            const value = this.value();
            const version = value.background.image?.version ?? value.background_image_version;
            this.imageColor.set(null);
            if (value.background.kind !== 'image' || !version) {
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
    }

    setRadius(raw: string): void {
        const n = Math.round(Number(raw));
        if (Number.isFinite(n)) {
            this.store.update({ bubble_radius: Math.min(BUBBLE_RADIUS_MAX, Math.max(BUBBLE_RADIUS_MIN, n)) });
        }
    }

    stepRadius(delta: number): void {
        this.setRadius(String(this.value().bubble_radius + delta));
    }

    /** Pick the already uploaded picture again (after another background was chosen), or ask for a new one. */
    useImage(input: HTMLInputElement): void {
        const version = this.value().background_image_version;
        if (version) {
            this.imageError.set(null);
            this.store.update({
                background: {
                    kind: 'image',
                    color: null,
                    gradient: null,
                    image: { ...(this.image() ?? DEFAULT_BACKGROUND_IMAGE), version },
                },
            });
        } else {
            input.click();
        }
    }

    onFileInput(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (file) {
            void this.upload(file);
        }
    }

    onDragOver(event: DragEvent): void {
        event.preventDefault();
        this.dragOver.set(true);
    }

    onDrop(event: DragEvent): void {
        event.preventDefault();
        this.dragOver.set(false);
        const file = event.dataTransfer?.files?.[0];
        if (file) {
            void this.upload(file);
        }
    }

    async upload(file: File): Promise<void> {
        this.imageError.set(null);
        this.uploading.set(true);
        try {
            const result = await this.store.uploadBackgroundImage(file);
            if (!result.ok) {
                this.imageError.set(result.message);
            }
        } finally {
            this.uploading.set(false);
        }
    }

    setFit(fit: BackgroundImageFit): void {
        this.patchImage({ fit });
    }

    setTuning(key: 'position_x' | 'position_y' | 'zoom' | 'dim' | 'blur', raw: string, min: number, max: number): void {
        const n = Math.round(Number(raw));
        if (Number.isFinite(n)) {
            this.patchImage({ [key]: Math.min(max, Math.max(min, n)) });
        }
    }

    private patchImage(patch: Partial<BackgroundImageSettings>): void {
        const current = this.image() ?? { ...DEFAULT_BACKGROUND_IMAGE, version: this.value().background_image_version };
        this.store.update({
            background: { kind: 'image', color: null, gradient: null, image: { ...current, ...patch } },
        });
    }

    async removeImage(): Promise<void> {
        const ok = await this.confirm.ask({
            title: 'Remove background image?',
            message: 'The picture is deleted and the default background is used again.',
            confirmLabel: 'Remove',
            danger: true,
        });
        if (ok) {
            this.imageError.set(null);
            await this.store.removeBackgroundImage();
        }
    }

    readonly min = FONT_SIZE_MIN;
    readonly max = FONT_SIZE_MAX;
    readonly families = FONT_FAMILIES.map((id) => ({ id, label: FONT_LABELS[id], stack: FONT_STACKS[id] }));
    readonly bubbleSwatches = BUBBLE_SWATCHES;
    readonly backgroundSwatches = BACKGROUND_SWATCHES;
    readonly gradients = GRADIENT_PRESETS.map((id) => ({ id, css: GRADIENT_CSS[id] }));

    readonly ownPicker = computed(() => this.value().own_bubble_color ?? DEFAULT_OWN_PICKER);
    readonly otherPicker = computed(() => this.value().other_bubble_color ?? DEFAULT_OTHER_PICKER);
    readonly bgPicker = computed(() => this.value().background.color ?? DEFAULT_BG_PICKER);

    setFontSize(raw: string): void {
        const n = Math.round(Number(raw));
        if (Number.isFinite(n)) {
            this.store.update({ font_size: Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n)) });
        }
    }

    stepFontSize(delta: number): void {
        this.setFontSize(String(this.value().font_size + delta));
    }

    setFontFamily(id: string): void {
        this.store.update({ font_family: id as AppearanceFontFamily });
    }

    setBubble(which: 'own' | 'other', color: string | null): void {
        this.store.update(which === 'own' ? { own_bubble_color: color } : { other_bubble_color: color });
    }

    setBackgroundDefault(): void {
        this.store.update({ background: { kind: 'default', color: null, gradient: null } });
    }

    setBackgroundColor(color: string): void {
        this.store.update({ background: { kind: 'color', color, gradient: null } });
    }

    setBackgroundGradient(gradient: AppearanceGradient): void {
        this.store.update({ background: { kind: 'gradient', color: null, gradient } });
    }

    async reset(): Promise<void> {
        const ok = await this.confirm.ask({
            title: 'Reset appearance?',
            message: 'Font, bubble colours and background will go back to the defaults.',
            confirmLabel: 'Reset',
            danger: true,
        });
        if (ok) {
            await this.store.reset();
        }
    }
}
