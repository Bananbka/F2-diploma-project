import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    signal,
    untracked,
} from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { LucideAngularModule, WifiOff } from 'lucide-angular';

import { appearanceVars } from '../../../core/services/appearance-css';
import { AppearanceStore } from '../../../core/services/appearance-store.service';
import { BackgroundImageService } from '../../../core/services/background-image.service';
import { ChatPanelStoreService } from '../../../core/services/chat-panel-store.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { ContactsStoreService } from '../../../core/services/contacts-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { FolderStoreService } from '../../../core/services/folder-store.service';
import { SessionService } from '../../../core/services/session.service';
import { ResizablePanelComponent } from '../../../shared/ui/resizable-panel/resizable-panel.component';
import { ChatPanelComponent } from '../chat-panel/chat-panel.component';
import { ChatSidebarComponent } from '../chat-sidebar/chat-sidebar.component';
import { ChatViewKey, folderKey } from '../chat-views';
import { ContactsListComponent } from '../contacts-list/contacts-list.component';
import { CreateChannelComponent } from '../create-channel/create-channel.component';
import { CreateDialogService } from '../create-dialog.service';
import { CreateGroupComponent } from '../create-group/create-group.component';
import { firstVisibleChatView, isHiddenSelection } from '../default-views';
import { InfoDialogComponent } from '../info-dialog/info-dialog.component';
import { InfoDialogService } from '../info-dialog/info-dialog.service';
import { NavigationRailComponent } from '../navigation-rail/navigation-rail.component';
import { TrustDialogComponent } from '../trust-dialog/trust-dialog.component';
import { TrustDialogService } from '../trust-dialog/trust-dialog.service';

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
        ContactsListComponent,
        CreateGroupComponent,
        CreateChannelComponent,
        InfoDialogComponent,
        TrustDialogComponent,
    ],
    templateUrl: './chat-shell.component.html',
    styleUrl: './chat-shell.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { '[style]': 'appearanceStyle()' },
})
export class ChatShellComponent {
    private readonly appearance = inject(AppearanceStore);

    /** The user's chat appearance as custom properties scoped to the chat, not to the whole page. */
    private readonly backgroundImages = inject(BackgroundImageService);
    /** Average colour of the background picture, sampled once per version; null until known. */
    private readonly imageColor = signal<string | null>(null);

    readonly appearanceStyle = computed(() => appearanceVars(this.appearance.value(), this.imageColor()));

    private readonly store = inject(ChatStoreService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);
    private readonly destroyRef = inject(DestroyRef);

    private readonly panel = inject(ChatPanelStoreService);

    private readonly folderStore = inject(FolderStoreService);
    private readonly contactsStore = inject(ContactsStoreService);
    readonly infoDialog = inject(InfoDialogService);
    readonly trustDialog = inject(TrustDialogService);

    /** The selected view of the chat list: chosen on the rail, applied by the sidebar. */
    readonly view = signal<ChatViewKey>('all');
    readonly panelOpen = this.panel.open;

    /** The Contacts view takes the chat list's place in the sidebar column while it is on. */
    readonly contactsOpen = signal(false);
    readonly createDialog = inject(CreateDialogService).open;

    selectView(key: ChatViewKey): void {
        this.contactsOpen.set(false);
        this.view.set(key);
    }

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
        // Hiding the view that is on screen moves to the first one still visible; Contacts closes if hidden.
        effect(() => {
            const hidden = this.appearance.value().hidden_views;
            if (isHiddenSelection(hidden, this.view())) {
                this.view.set(firstVisibleChatView(hidden));
            }
            if (hidden.includes('contacts') && this.contactsOpen()) {
                this.contactsOpen.set(false);
            }
        });

        // Contacts are needed by chat info ("saved" state) long before the Contacts view opens.
        void this.contactsStore.load();

        // A selected folder that is gone (deleted here or elsewhere) must not leave the list
        // filtered by nothing while the rail shows no selection: fall back to everything.
        effect(() => {
            const view = this.view();
            if (
                view.startsWith('folder:') &&
                this.folderStore.loaded() &&
                !this.folderStore.folders().some((f) => folderKey(f.id) === view)
            ) {
                untracked(() => this.view.set('all'));
            }
        });

        void this.appearance.load();

        effect((onCleanup) => {
            const value = this.appearance.value();
            const version = value.background.image?.version ?? value.background_image_version;
            this.imageColor.set(null);
            if (value.background.kind !== 'image' || !version) {
                return;
            }
            let cancelled = false;
            onCleanup(() => (cancelled = true));
            void this.backgroundImages.colorFor(version).then((color) => {
                if (!cancelled) {
                    this.imageColor.set(color);
                }
            });
        });
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

        this.trustDialog.openSecurity(chat, me);
    }
}
