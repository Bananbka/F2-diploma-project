import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';

import { BackgroundImageSettings } from '../../../core/models/appearance.model';
import { BackgroundImageService } from '../../../core/services/background-image.service';

/** Styles for the picture layer. Pure, so the mapping from settings to CSS can be tested directly. */
export function backgroundLayerStyle(image: BackgroundImageSettings, url: string): Record<string, string> {
    // Blur softens the edges, which would show a lighter rim; a slight extra scale hides it.
    const blurScale = image.blur > 0 ? 1.05 : 1;
    const scale = (image.zoom / 100) * blurScale;
    const origin = `${image.position_x}% ${image.position_y}%`;
    return {
        'background-image': `url("${url}")`,
        'background-size': image.fit === 'tile' ? 'auto' : image.fit,
        'background-repeat': image.fit === 'tile' ? 'repeat' : 'no-repeat',
        'background-position': origin,
        transform: `scale(${scale})`,
        'transform-origin': origin,
        filter: image.blur > 0 ? `blur(${image.blur}px)` : 'none',
    };
}

/** The dark veil over the picture, as a plain rgba so it needs no extra element state. */
export function dimStyle(image: BackgroundImageSettings): Record<string, string> {
    return { background: `rgb(0 0 0 / ${image.dim}%)` };
}

/**
 * The chat's background picture, in its own absolutely positioned layer behind the content (never on
 * the scroll container, so it neither scrolls nor tiles oddly). A missing or failed image renders
 * nothing, which leaves the default background showing.
 */
@Component({
    selector: 'app-chat-background',
    templateUrl: './chat-background.component.html',
    styleUrl: './chat-background.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatBackgroundComponent {
    private readonly images = inject(BackgroundImageService);

    readonly image = input<BackgroundImageSettings | null | undefined>(null);
    /** Falls back to the image settings' own version; the document-level version is the newer source. */
    readonly version = input<string | null>(null);

    private readonly url = signal<string | null>(null);

    readonly layerStyle = computed(() => {
        const image = this.image();
        const url = this.url();
        return image && url ? backgroundLayerStyle(image, url) : null;
    });
    readonly dim = computed(() => {
        const image = this.image();
        return image && this.url() ? dimStyle(image) : null;
    });

    constructor() {
        effect((onCleanup) => {
            const image = this.image();
            const version = this.version() ?? image?.version ?? null;
            this.url.set(null);
            if (!image || !version) {
                return;
            }
            let cancelled = false;
            onCleanup(() => (cancelled = true));
            void this.images.load(version).then((url) => {
                if (!cancelled) {
                    this.url.set(url);
                }
            });
        });
    }
}
