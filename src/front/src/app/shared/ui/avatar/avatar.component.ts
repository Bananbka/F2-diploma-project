import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { Hash, LucideAngularModule, Users, UserX } from 'lucide-angular';

import { avatarColor, groupInitials, initials } from '../../utils/display';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

/** What the avatar stands for. Groups and channels take their monogram from the title's words. */
export type AvatarKind = 'person' | 'group' | 'channel';

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
    /** A deleted account: a neutral grey face with no initials, never a stale photo or colour. */
    readonly deleted = input(false);

    /** People and groups share the same coloured circle; only how the letters are chosen differs. */
    readonly kind = input<AvatarKind>('person');

    /** The last URL that failed to load; while `imageUrl` is still that value the monogram shows instead. */
    readonly failedUrl = signal<string | null>(null);

    /** Letters (or a lone emoji) for the circle. Empty means "no letters": the kind's icon is shown. */
    readonly monogram = computed(() => (this.kind() === 'person' ? initials(this.name()) : groupInitials(this.name())));
    readonly color = computed(() => avatarColor(this.seed() || this.name()));

    readonly hashIcon = Hash;
    readonly usersIcon = Users;
    readonly deletedIcon = UserX;
}
