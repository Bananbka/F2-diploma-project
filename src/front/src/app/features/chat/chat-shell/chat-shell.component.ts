import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { LucideAngularModule, WifiOff } from 'lucide-angular';

import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { SessionService } from '../../../core/services/session.service';
import { ChatSidebarComponent } from '../chat-sidebar/chat-sidebar.component';
import { ChatFilter, NavigationRailComponent } from '../navigation-rail/navigation-rail.component';

@Component({
    selector: 'app-chat-shell',
    imports: [RouterOutlet, LucideAngularModule, NavigationRailComponent, ChatSidebarComponent],
    templateUrl: './chat-shell.component.html',
    styleUrl: './chat-shell.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatShellComponent {
    private readonly store = inject(ChatStoreService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);

    readonly filter = signal<ChatFilter>('all');

    readonly isOnline = this.store.isOnline;
    readonly activeChatId = this.store.activeChatId;

    /** On narrow screens the sidebar and the conversation are alternate views, not columns. */
    readonly showConversationOnly = computed(() => this.activeChatId() !== null);

    readonly wifiOffIcon = WifiOff;

    constructor() {
        this.store.bindRealtime();
        void this.store.loadChats();
        void this.directory.warm();
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
