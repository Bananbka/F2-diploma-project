import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import { LucideAngularModule, Smile, Sticker, X } from 'lucide-angular';

import { Sticker as StickerModel } from '../../../core/models/sticker.model';
import { ChatPanelStoreService, PICKER_TABS, PickerTab } from '../../../core/services/chat-panel-store.service';
import { PickerRecentsService } from '../../../core/services/picker-recents.service';
import { EmojiPickerComponent } from '../../../shared/ui/emoji-picker/emoji-picker.component';
import { ResizablePanelComponent } from '../../../shared/ui/resizable-panel/resizable-panel.component';
import { ChatInfoComponent } from '../chat-info/chat-info.component';
import { StickerPickerComponent } from '../stickers/sticker-picker/sticker-picker.component';

/** Below this the panel is a slide-over covering the conversation instead of a docked column. */
const OVERLAY_QUERY = '(width < 72rem)';

interface TabView {
    id: PickerTab;
    label: string;
    icon: typeof Smile;
}

const TAB_VIEWS: readonly TabView[] = [
    { id: 'emoji', label: 'Emoji', icon: Smile },
    { id: 'stickers', label: 'Stickers', icon: Sticker },
];

/**
 * The conversation's right-hand panel. One panel with two views: the emoji/sticker picker (tabs
 * "Emoji" and "Stickers", opened from the composer's smiley) and the chat info (opened from the
 * conversation header). Each entry point toggles its own view, so the panel is always showing
 * exactly what the button that opened it says.
 *
 * Docked beside the conversation on wide screens; a slide-over with a backdrop (closable with
 * Escape) on narrow ones. The picker never touches the composer directly: it goes through the
 * bridge the live composer registers in `ChatPanelStoreService`, so every guard the composer
 * applies (blocked member set, read-only peer, editing, recording) applies here too, and the picker
 * is disabled with the reason spelled out when it refuses.
 */
@Component({
    selector: 'app-chat-panel',
    imports: [
        LucideAngularModule,
        ChatInfoComponent,
        StickerPickerComponent,
        EmojiPickerComponent,
        ResizablePanelComponent,
    ],
    templateUrl: './chat-panel.component.html',
    styleUrl: './chat-panel.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        '[class.is-overlay]': 'overlay()',
        '(document:keydown.escape)': 'onEscape($event)',
    },
})
export class ChatPanelComponent {
    private readonly panel = inject(ChatPanelStoreService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly chatId = input.required<string>();

    private readonly recents = inject(PickerRecentsService);

    readonly tabs = TAB_VIEWS;
    readonly view = this.panel.view;
    readonly tab = this.panel.pickerTab;
    readonly recentEmoji = this.recents.emoji;
    readonly recentStickerIds = this.recents.stickerIds;
    readonly overlay = signal(window.matchMedia(OVERLAY_QUERY).matches);
    /** Bodies shown at least once. The sticker tab fetches on creation, so build lazily and keep. */
    readonly visited = signal<ReadonlySet<string>>(new Set());

    /**
     * Why the sticker/emoji tabs cannot be used right now, or null. While messages are being
     * selected there is no composer; that state is deliberately silent (no notice is inserted, so
     * the layout cannot shift) and only disables the pickers, see `locked`.
     */
    readonly unavailableReason = computed(() => this.panel.composer()?.unavailableReason() ?? null);

    /** The insert actions are inert: the composer refuses them, or there is no composer (selection mode). */
    readonly locked = computed(() => this.panel.composer() === null || this.unavailableReason() !== null);

    /** Set after a pick the composer turned down in the instant between render and click. */
    readonly refused = signal(false);

    readonly closeIcon = X;

    constructor() {
        const media = window.matchMedia(OVERLAY_QUERY);
        const onChange = (event: MediaQueryListEvent) => this.overlay.set(event.matches);
        media.addEventListener('change', onChange);
        this.destroyRef.onDestroy(() => media.removeEventListener('change', onChange));

        effect(() => {
            const shown = this.view() === 'profile' ? 'profile' : this.tab();
            untracked(() => this.visited.update((seen) => (seen.has(shown) ? seen : new Set(seen).add(shown))));
        });

        // A slide-over takes over the screen, so move focus into it; a docked panel must not steal
        // focus from the composer the user is typing in.
        effect(() => {
            if (this.overlay()) {
                untracked(() =>
                    this.elementRef.nativeElement.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus()
                );
            }
        });
    }

    close(): void {
        this.panel.close();
    }

    onEscape(event?: Event): void {
        // A view inside the panel (a member profile) that used Escape to go back has already handled it.
        if (event?.defaultPrevented) {
            return;
        }
        if (this.overlay()) {
            this.close();
        }
    }

    selectTab(tab: PickerTab): void {
        this.refused.set(false);
        this.panel.selectPickerTab(tab);
    }

    /** Roving tabindex: arrows/Home/End move between tabs and select them, per the tabs pattern. */
    onTabKeydown(event: KeyboardEvent): void {
        const order = PICKER_TABS;
        const index = order.indexOf(this.tab());
        let next: number;
        switch (event.key) {
            case 'ArrowRight':
                next = (index + 1) % order.length;
                break;
            case 'ArrowLeft':
                next = (index - 1 + order.length) % order.length;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = order.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        this.selectTab(order[next]);
        this.elementRef.nativeElement.querySelector<HTMLElement>(`#chat-panel-tab-${order[next]}`)?.focus();
    }

    onEmojiPicked(emoji: string): void {
        const accepted = this.panel.composer()?.insertEmoji(emoji) ?? false;
        this.refused.set(!accepted);
        if (accepted) {
            this.recents.addEmoji(emoji);
        }
    }

    onEmojiRecentRemoved(emoji: string): void {
        this.recents.removeEmoji(emoji);
    }

    onStickerRecentRemoved(stickerId: string): void {
        this.recents.removeSticker(stickerId);
    }

    onStickerPicked(sticker: StickerModel): void {
        const accepted = this.panel.composer()?.sendSticker(sticker) ?? false;
        this.refused.set(!accepted);
        if (accepted) {
            this.recents.addSticker(sticker.id);
        }
    }
}
