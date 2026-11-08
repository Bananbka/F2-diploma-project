import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { TwemojiPipe } from '../../../shared/emoji/twemoji.pipe';

/**
 * One reaction under a message: a pill with the emoji (Twemoji) and its count. Shared by the message
 * bubble and the appearance previews so they cannot drift apart. Coloured from the `--chat-chip-*`
 * and `--chat-meta-*` variables the appearance settings derive from the chat background.
 */
@Component({
    selector: 'app-reaction-chip',
    imports: [TwemojiPipe],
    templateUrl: './reaction-chip.component.html',
    styleUrl: './reaction-chip.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReactionChipComponent {
    readonly emoji = input.required<string>();
    readonly count = input(1);
    /** I reacted with this one. */
    readonly mine = input(false);
    /** False in previews: the chip then looks the same but cannot be pressed. */
    readonly interactive = input(true);

    readonly chipClick = output<void>();

    readonly label = computed(() => `${this.emoji()} reaction, ${this.count()}`);
}
