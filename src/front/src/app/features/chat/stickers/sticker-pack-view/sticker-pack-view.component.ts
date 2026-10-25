import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Check, LucideAngularModule, Plus } from 'lucide-angular';

import { StickerPack } from '../../../../core/models/sticker.model';

/**
 * Presentational view of one sticker pack: its name, a grid of its stickers and, when the viewer
 * can act on it, a Subscribe/Unsubscribe control. It loads nothing and owns no subscription state,
 * so any host (the in-chat dialog today) can drive it.
 */
@Component({
    selector: 'app-sticker-pack-view',
    imports: [LucideAngularModule],
    templateUrl: './sticker-pack-view.component.html',
    styleUrl: './sticker-pack-view.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StickerPackViewComponent {
    readonly pack = input.required<StickerPack>();
    readonly subscribed = input(false);
    /** The viewer's own pack: it is already theirs, so there is nothing to subscribe to. */
    readonly isOwn = input(false);
    readonly busy = input(false);

    readonly subscribeToggled = output<void>();

    readonly plusIcon = Plus;
    readonly checkIcon = Check;
}
