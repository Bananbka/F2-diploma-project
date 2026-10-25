import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { LucideAngularModule, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { StickerPack } from '../../../../core/models/sticker.model';
import { DirectoryService } from '../../../../core/services/directory.service';
import { StickerApiService } from '../../../../core/services/sticker-api.service';
import { StickerPackViewComponent } from '../sticker-pack-view/sticker-pack-view.component';

type DialogState = 'loading' | 'ready' | 'unavailable' | 'error';

/**
 * Modal that shows the pack a sticker in a message belongs to, resolved from the sticker's url.
 *
 * "Unavailable" (404 `STICKER_PACK_UNAVAILABLE`: deleted, made private, or not a pack sticker) is a
 * distinct, explicit state: telling it apart from a transient failure tells the reader whether
 * retrying could ever help.
 */
@Component({
    selector: 'app-sticker-pack-dialog',
    imports: [LucideAngularModule, StickerPackViewComponent],
    templateUrl: './sticker-pack-dialog.component.html',
    styleUrl: './sticker-pack-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class StickerPackDialogComponent {
    private readonly stickerApi = inject(StickerApiService);
    private readonly directory = inject(DirectoryService);

    /** The tapped sticker's image url. */
    readonly stickerUrl = input.required<string>();
    readonly closed = output<void>();

    readonly state = signal<DialogState>('loading');
    readonly pack = signal<StickerPack | null>(null);
    readonly subscribed = signal(false);
    readonly busy = signal(false);
    readonly actionError = signal<string | null>(null);

    readonly closeIcon = X;

    constructor() {
        effect(() => {
            const url = this.stickerUrl();
            untracked(() => void this.load(url));
        });
    }

    isOwn(pack: StickerPack): boolean {
        return this.directory.isMe(pack.owner_id);
    }

    async load(url: string): Promise<void> {
        this.state.set('loading');
        this.pack.set(null);
        this.actionError.set(null);
        try {
            const pack = await firstValueFrom(this.stickerApi.getPackByUrl(url));
            this.pack.set(pack);
            this.state.set('ready');
            await this.loadSubscription(pack.id);
        } catch (error) {
            const unavailable =
                error instanceof HttpErrorResponse &&
                error.status === 404 &&
                error.error?.error_code === 'STICKER_PACK_UNAVAILABLE';
            this.state.set(unavailable ? 'unavailable' : 'error');
        }
    }

    /** Non-fatal: without it the button just starts from "Subscribe". */
    private async loadSubscription(packId: string): Promise<void> {
        try {
            const mine = await firstValueFrom(this.stickerApi.getMyPacks());
            this.subscribed.set(mine.some((p) => p.id === packId));
        } catch {
            this.subscribed.set(false);
        }
    }

    async toggleSubscribe(): Promise<void> {
        const pack = this.pack();
        if (!pack || this.busy()) {
            return;
        }
        this.busy.set(true);
        this.actionError.set(null);
        try {
            if (this.subscribed()) {
                await firstValueFrom(this.stickerApi.unsubscribe(pack.id));
                this.subscribed.set(false);
            } else {
                await firstValueFrom(this.stickerApi.subscribe(pack.id));
                this.subscribed.set(true);
            }
        } catch {
            this.actionError.set('Could not update that subscription.');
        } finally {
            this.busy.set(false);
        }
    }
}
