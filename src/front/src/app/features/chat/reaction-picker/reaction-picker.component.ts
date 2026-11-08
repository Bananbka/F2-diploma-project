import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import { LucideAngularModule, Plus, Smile } from 'lucide-angular';

import { TwemojiPipe } from '../../../shared/emoji/twemoji.pipe';
import { placePopover } from '../../../shared/ui/emoji-field/emoji-button.component';
import { EMOJI_NAMES } from '../../../shared/ui/emoji-picker/emoji-data';
import { EmojiPickerComponent } from '../../../shared/ui/emoji-picker/emoji-picker.component';
import { ReactionRecentsService } from './reaction-recents.service';

/** The built-in grid, in display order, row by row. */
export const BUILT_IN_REACTIONS: readonly string[] = [
    '💀',
    '🥰',
    '🔥',
    '💔',
    '❤️',
    '😭',
    '🤡',
    '😡',
    '🙏',
    '👍',
    '👎',
    '🍌',
    '😨',
    '😢',
    '😁',
    '💩',
    '🐷',
];

const GRID_COLUMNS = 6;
const POPOVER_Z_INDEX = 100;
const FALLBACK_SIZE = { width: 260, height: 220 };

type Mode = 'quick' | 'grid' | 'full';

/**
 * The reaction popover: a quick bar of recent reactions with a "+" that expands, in place, into a grid
 * of built-ins and a "More emoji…" button that swaps in the full picker. Portalled to `<body>` and
 * placed from the anchor's rect so a scrolling chat cannot clip it. Escape closes only this popover.
 */
@Component({
    selector: 'app-reaction-picker',
    imports: [TwemojiPipe, LucideAngularModule, EmojiPickerComponent],
    templateUrl: './reaction-picker.component.html',
    styleUrl: './reaction-picker.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReactionPickerComponent {
    private readonly recents = inject(ReactionRecentsService);
    private readonly destroyRef = inject(DestroyRef);

    /** The trigger button the popover hangs from. */
    readonly anchor = input.required<HTMLElement>();
    /** Reactions I already have on this message; they stay highlighted and picking one removes it. */
    readonly mine = input<readonly string[]>([]);

    readonly picked = output<string>();
    readonly closed = output<void>();

    readonly mode = signal<Mode>('quick');
    readonly quick = this.recents.quickBar();
    readonly builtIn = BUILT_IN_REACTIONS;
    readonly plusIcon = Plus;
    readonly smileIcon = Smile;

    private readonly root = viewChild<ElementRef<HTMLElement>>('root');

    constructor() {
        effect((onCleanup) => {
            const ref = this.root();
            if (!ref) {
                return;
            }
            const element = ref.nativeElement;
            const reposition = (event?: Event): void => {
                if (event?.target instanceof Node && element.contains(event.target)) {
                    return;
                }
                this.place(element);
            };
            const onKey = (event: KeyboardEvent): void => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    event.preventDefault();
                    this.closed.emit();
                }
            };

            untracked(() => {
                document.body.appendChild(element);
                element.style.position = 'fixed';
                element.style.zIndex = String(POPOVER_Z_INDEX);
                this.place(element);
                element.querySelector<HTMLElement>('button[data-emoji]')?.focus();
            });

            window.addEventListener('resize', reposition);
            window.addEventListener('scroll', reposition, true);
            document.addEventListener('keydown', onKey, true);
            onCleanup(() => {
                window.removeEventListener('resize', reposition);
                window.removeEventListener('scroll', reposition, true);
                document.removeEventListener('keydown', onKey, true);
                element.remove();
            });
        });

        // Resizing as the popover grows (quick -> grid -> full) must keep it inside the viewport.
        effect(() => {
            this.mode();
            const element = untracked(() => this.root()?.nativeElement);
            if (element) {
                requestAnimationFrame(() => this.place(element));
            }
        });

        this.destroyRef.onDestroy(() => undefined);
    }

    label(emoji: string): string {
        return EMOJI_NAMES[emoji] ?? emoji;
    }

    isMine(emoji: string): boolean {
        return this.mine().includes(emoji);
    }

    expand(): void {
        this.mode.set('grid');
    }

    openFull(): void {
        this.mode.set('full');
    }

    pick(emoji: string): void {
        this.recents.record(emoji);
        this.picked.emit(emoji);
        this.closed.emit();
    }

    /** Arrow keys walk the visible emoji buttons: left/right by one, up/down by a row in the grid. */
    onKeydown(event: KeyboardEvent): void {
        const root = this.root()?.nativeElement;
        if (!root || this.mode() === 'full') {
            return;
        }
        const keys: Record<string, number> = {
            ArrowRight: 1,
            ArrowLeft: -1,
            ArrowDown: this.mode() === 'grid' ? GRID_COLUMNS : 1,
            ArrowUp: this.mode() === 'grid' ? -GRID_COLUMNS : -1,
        };
        const step = keys[event.key];
        if (step === undefined) {
            return;
        }
        const buttons = [...root.querySelectorAll<HTMLElement>('button[data-nav]')];
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        if (index === -1) {
            return;
        }
        event.preventDefault();
        const next = Math.min(buttons.length - 1, Math.max(0, index + step));
        buttons[next].focus();
    }

    private place(element: HTMLElement): void {
        const anchor = this.anchor().getBoundingClientRect();
        const size = {
            width: element.offsetWidth || FALLBACK_SIZE.width,
            height: element.offsetHeight || FALLBACK_SIZE.height,
        };
        const point = placePopover(anchor, size, { width: window.innerWidth, height: window.innerHeight });
        element.style.left = `${point.left}px`;
        element.style.top = `${point.top}px`;
    }
}
