import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Hash, LucideAngularModule } from 'lucide-angular';

import { avatarColor, initials } from '../../utils/display';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

@Component({
    selector: 'app-avatar',
    imports: [LucideAngularModule],
    templateUrl: './avatar.component.html',
    styleUrl: './avatar.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '[class]': 'size()' },
})
export class AvatarComponent {
    readonly name = input.required<string>();
    /** Colours the monogram. Pass a user or chat id so the colour is stable across renames. */
    readonly seed = input<string>('');
    readonly imageUrl = input<string | null>(null);
    readonly size = input<AvatarSize>('md');
    /** Omit entirely to render no presence dot — absent and offline are different things. */
    readonly online = input<boolean | undefined>(undefined);

    readonly monogram = computed(() => initials(this.name()));
    readonly color = computed(() => avatarColor(this.seed() || this.name()));
    readonly isChannel = computed(() => this.name().startsWith('#'));

    readonly hashIcon = Hash;
}
