import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { LucideAngularModule, WifiOff } from 'lucide-angular';

import { ChatPanelStoreService } from '../../../core/services/chat-panel-store.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { SessionService } from '../../../core/services/session.service';
import { ResizablePanelComponent } from '../../../shared/ui/resizable-panel/resizable-panel.component';
import { ChatPanelComponent } from '../chat-panel/chat-panel.component';
import { ChatSidebarComponent } from '../chat-sidebar/chat-sidebar.component';
import { ChatFilter, NavigationRailComponent } from '../navigation-rail/navigation-rail.component';

/** Matches the `@media (width < 48rem)` breakpoint in the shell's own stylesheet. */
const NARROW_QUERY = '(width < 48rem)';

@Component({
    selector: 'app-chat-shell',
    imports: [
        RouterOutlet,
        LucideAngularModule,
        NavigationRailComponent,
        ChatSidebarComponent,
        ResizablePanelComponent,
        ChatPanelComponent,
    ],
    templateUrl: './chat-shell.component.html',
    styleUrl: './chat-shell.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatShellComponent {
    private readonly store = inject(ChatStoreService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly destroyRef = inject(DestroyRef);

    private readonly panel = inject(ChatPanelStoreService);

    readonly filter = signal<ChatFilter>('all');
    readonly panelOpen = this.panel.open;

    readonly isOnline = this.store.isOnline;
    readonly activeChatId = this.store.activeChatId;

    /** On narrow screens the sidebar and the conversation are alternate views, not columns. */
    readonly showConversationOnly = computed(() => this.activeChatId() !== null);

    /**
     * Drives whether the resizable panel around the sidebar is disabled.
     *
     * `<app-chat-sidebar>` is rendered exactly once, always inside `<app-resizable-panel>` — the
     * panel used to be swapped in and out of an `@if`/`@else` depending on this flag, which
     * destroyed and recreated the sidebar (and its local search/menu/folder-draft state) on every
     * breakpoint cross. Disabling the panel instead just drops its inline `style.width`, letting the
     * plain `.sidebar` class rule the narrow-screen layout relies on force full width without a more
     * specific inline style fighting it, while the sidebar component itself never moves.
     */
    readonly isNarrow = signal(this.matchNarrow().matches);

    readonly wifiOffIcon = WifiOff;

    constructor() {
        this.store.bindRealtime();
        void this.store.loadChats();
        void this.directory.warm();

        const media = this.matchNarrow();
        const onChange = (event: MediaQueryListEvent) => this.isNarrow.set(event.matches);
        media.addEventListener('change', onChange);
        this.destroyRef.onDestroy(() => media.removeEventListener('change', onChange));
    }

    private matchNarrow(): MediaQueryList {
        return window.matchMedia(NARROW_QUERY);
    }

    /**
     * The rail's shield opens the safety number for the current conversation's counterpart.
     *
     * With no conversation open there is no peer to compare against, so this falls through to the
     * chat info screen rather than inventing a target.
     */
    async openSecurity(): Promise<void> {
        const chat = this.store.activeChat();
        const me = this.session.user()?.id;

        if (!chat) {
            return;
        }

        const peer = chat.participants.find((p) => p.user_id !== me);
        await this.router.navigate(peer ? ['/chats', chat.id, 'safety', peer.user_id] : ['/chats', chat.id, 'info']);
    }
}
