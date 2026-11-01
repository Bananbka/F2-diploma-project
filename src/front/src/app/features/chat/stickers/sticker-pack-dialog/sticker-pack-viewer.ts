import { ChangeDetectionStrategy, Component, inject, Injectable, signal } from '@angular/core';

import { StickerPackDialogComponent } from './sticker-pack-dialog.component';

/**
 * Opens the sticker-pack dialog from anywhere: a sticker in a message, in the picker, or in
 * "Recently used". The dialog resolves the pack from a sticker's image url, so a caller only needs
 * that url — not a pack id, which the "Recently used" list does not carry.
 */
@Injectable({ providedIn: 'root' })
export class StickerPackViewerService {
    readonly url = signal<string | null>(null);

    open(stickerUrl: string): void {
        this.url.set(stickerUrl);
    }

    close(): void {
        this.url.set(null);
    }
}

/** Mounted once in the app root. */
@Component({
    selector: 'app-sticker-pack-viewer-host',
    imports: [StickerPackDialogComponent],
    template: `
        @if (viewer.url(); as url) {
            <app-sticker-pack-dialog
                [stickerUrl]="url"
                (closed)="viewer.close()"
            />
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StickerPackViewerHostComponent {
    protected readonly viewer = inject(StickerPackViewerService);
}
