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
import { LucideAngularModule, Smile, Sticker, User, X } from 'lucide-angular';

import { Sticker as StickerModel } from '../../../core/models/sticker.model';
import { CHAT_PANEL_TABS, ChatPanelStoreService, ChatPanelTab } from '../../../core/services/chat-panel-store.service';
import { EmojiPickerComponent } from '../../../shared/ui/emoji-picker/emoji-picker.component';
import { ChatInfoComponent } from '../chat-info/chat-info.component';
import { StickerPickerComponent } from '../stickers/sticker-picker/sticker-picker.component';

/** Below this the panel is a slide-over covering the conversation instead of a docked column. */
const OVERLAY_QUERY = '(width < 72rem)';

interface TabView {
    id: ChatPanelTab;
    label: string;
    icon: typeof User;
}

const TAB_VIEWS: readonly TabView[] = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'stickers', label: 'Stickers', icon: Sticker },
    { id: 'emoji', label: 'Emoji', icon: Smile },
];

/**
 * The conversation's right-hand panel: profile / chat info, the sticker tray and an emoji grid.
 *
 * Docked beside the conversation on wide screens; a slide-over with a backdrop (closable with
 * Escape) on narrow ones. The sticker and emoji tabs never touch the composer directly: they go
 * through the bridge the live composer registers in `ChatPanelStoreService`, so every guard the
 * composer applies to its own buttons (blocked member set, read-only peer, editing, recording)
 * applies here too, and the tabs are disabled with the reason spelled out when it refuses.
 */
@Component({
    selector: 'app-chat-panel',
    imports: [LucideAngularModule, ChatInfoComponent, StickerPickerComponent, EmojiPickerComponent],
    templateUrl: './chat-panel.component.html',
    styleUrl: './chat-panel.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        '[class.is-overlay]': 'overlay()',
        '(document:keydown.escape)': 'onEscape()',
    },
})
export class ChatPanelComponent {
    private readonly panel = inject(ChatPanelStoreService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly chatId = input.required<string>();

    readonly tabs = TAB_VIEWS;
    readonly tab = this.panel.tab;
    readonly overlay = signal(window.matchMedia(OVERLAY_QUERY).matches);
    /** Tabs opened at least once. The sticker tray fetches on creation, so build it lazily and keep it. */
    readonly visited = signal<ReadonlySet<ChatPanelTab>>(new Set([this.panel.tab()]));

    /** Why the sticker/emoji tabs cannot be used right now, or null. */
    readonly unavailableReason = computed(() => {
        const composer = this.panel.composer();
        return composer ? composer.unavailableReason() : 'Open a conversation to use this.';
    });

    /** Set after a pick the composer turned down in the instant between render and click. */
    readonly refused = signal(false);

    readonly closeIcon = X;

    constructor() {
        const media = window.matchMedia(OVERLAY_QUERY);
        const onChange = (event: MediaQueryListEvent) => this.overlay.set(event.matches);
        media.addEventListener('change', onChange);
        this.destroyRef.onDestroy(() => media.removeEventListener('change', onChange));

        effect(() => {
            const tab = this.tab();
            untracked(() => this.visited.update((seen) => (seen.has(tab) ? seen : new Set(seen).add(tab))));
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

    onEscape(): void {
        if (this.overlay()) {
            this.close();
        }
    }

    selectTab(tab: ChatPanelTab): void {
        this.refused.set(false);
        this.panel.selectTab(tab);
    }

    /** Roving tabindex: arrows/Home/End move between tabs and select them, per the tabs pattern. */
    onTabKeydown(event: KeyboardEvent): void {
        const order = CHAT_PANEL_TABS;
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
        this.refused.set(!this.panel.composer()?.insertEmoji(emoji));
    }

    onStickerPicked(sticker: StickerModel): void {
        this.refused.set(!this.panel.composer()?.sendSticker(sticker));
    }
}
