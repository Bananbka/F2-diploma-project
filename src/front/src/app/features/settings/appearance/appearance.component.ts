import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import {
    AppearanceFontFamily,
    AppearanceGradient,
    BACKGROUND_SWATCHES,
    BUBBLE_SWATCHES,
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
import { ColorPickerComponent } from '../../../shared/ui/color-picker/color-picker.component';
import { ConfirmService } from '../../../shared/ui/confirm-dialog/confirm.service';

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
    imports: [ColorPickerComponent],
    templateUrl: './appearance.component.html',
    styleUrl: './appearance.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppearanceComponent {
    private readonly store = inject(AppearanceStore);
    private readonly confirm = inject(ConfirmService);

    readonly value = this.store.value;
    readonly previewStyle = computed(() => appearanceVars(this.value()));

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
