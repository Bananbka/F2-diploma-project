import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
    AlertTriangle,
    ArrowLeft,
    CheckCheck,
    Copy,
    Forward,
    Info,
    LucideAngularModule,
    MessageSquare,
    Pencil,
    Pin,
    PinOff,
    RefreshCw,
    Reply,
    Shield,
    ShieldAlert,
    ShieldOff,
    SkipForward,
    Trash2,
    Users,
    X,
} from 'lucide-angular';

import { Chat } from '../../../core/models/chat.model';
import {
    ChatStoreService,
    ConversationItem,
    MessageReadReceipt,
    PendingMessage,
} from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { DecryptedMessage } from '../../../core/services/message.service';
import { SessionService } from '../../../core/services/session.service';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import {
    ContextMenuComponent,
    ContextMenuItem,
    MenuAnchor,
} from '../../../shared/ui/context-menu/context-menu.component';
import { ComposedMessage, ComposerComponent } from '../composer/composer.component';
import { MessageBubbleComponent } from '../message-bubble/message-bubble.component';

/**
 * How far the pointer must travel before a press becomes a message sweep rather than a click.
 *
 * Small enough to feel immediate, large enough that an unsteady click is not mistaken for a drag.
 */
const DRAG_SELECT_THRESHOLD_PX = 8;

@Component({
    selector: 'app-chat-view',
    imports: [
        RouterLink,
        LucideAngularModule,
        AvatarComponent,
        MessageBubbleComponent,
        ComposerComponent,
        ContextMenuComponent,
    ],
    templateUrl: './chat-view.component.html',
    styleUrl: './chat-view.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatViewComponent {
    private readonly store = inject(ChatStoreService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);
    private readonly router = inject(Router);

    /** Bound from the `:chatId` route parameter. */
    readonly chatId = input<string | undefined>(undefined);

    readonly chat = this.store.activeChat;
    readonly conversation = this.store.conversation;
    readonly loading = this.store.messagesLoading;
    readonly hasMoreHistory = this.store.hasMoreHistory;
    readonly isRekeying = this.store.isRekeying;
    readonly canSend = this.store.canSend;
    readonly memberVerificationError = this.store.memberVerificationError;
    readonly encryptionUnavailable = this.store.encryptionUnavailable;
    readonly sendBlockedReason = this.store.sendBlockedReason;
    readonly pinnedMessages = this.store.pinnedMessages;
    readonly canPinMessages = this.store.canPinMessages;

    readonly bannerDismissed = signal(false);
    /** The pinned-messages bar is dismissible per chat visit, not permanently. */
    readonly pinnedBannerDismissed = signal(false);
    readonly pinnedPanelOpen = signal(false);
    readonly replyingTo = signal<DecryptedMessage | null>(null);
    readonly editing = signal<DecryptedMessage | null>(null);

    readonly menuItems = signal<ContextMenuItem[]>([]);
    readonly menuAnchor = signal<MenuAnchor | null>(null);

    readonly isSelecting = this.store.isSelecting;
    readonly selectedIds = this.store.selectedIds;
    readonly selectionCount = this.store.selectionCount;
    readonly forwardableCount = this.store.forwardableCount;
    readonly deletableCount = this.store.deletableCount;

    /** Open only while choosing where to forward to. */
    readonly forwardPickerOpen = signal(false);

    /**
     * Every conversation, including this one.
     *
     * Forwarding back into the same chat is a normal thing to want — quoting something from further
     * up so it lands at the bottom. The current chat is marked rather than removed.
     */
    readonly forwardTargets = computed(() => {
        const current = this.chatId();
        return [...this.store.chats()].sort((a, b) => Number(b.id === current) - Number(a.id === current));
    });

    isCurrentChat(chat: Chat): boolean {
        return chat.id === this.chatId();
    }

    readonly isChannel = computed(() => this.chat()?.chat_type === 'channel');
    readonly isGroupLike = computed(() => this.chat()?.chat_type !== 'private');

    readonly title = computed(() => {
        const chat = this.chat();
        if (!chat) {
            return '';
        }
        return chat.title ?? (chat.chat_type === 'channel' ? 'Channel' : 'Untitled chat');
    });

    readonly subtitle = computed(() => {
        const chat = this.chat();
        if (!chat) {
            return '';
        }

        const typing = this.store.typingUserIds();
        if (typing.length === 1) {
            return `${this.directory.lookup(typing[0]).name} is typing…`;
        }
        if (typing.length > 1) {
            return `${typing.length} people are typing…`;
        }

        if (chat.chat_type === 'private') {
            const peer = chat.participants.find((p) => p.user_id !== this.session.user()?.id);
            return peer && this.store.onlineUserIds().includes(peer.user_id) ? 'Online' : 'Last seen recently';
        }

        const count = chat.participants.length;
        if (chat.chat_type === 'channel') {
            return count ? `${count} subscribers` : 'Channel';
        }
        return count ? `${count} members` : 'Group';
    });

    readonly peerId = computed(() => {
        const chat = this.chat();
        if (chat?.chat_type !== 'private') {
            return null;
        }
        return chat.participants.find((p) => p.user_id !== this.session.user()?.id)?.user_id ?? null;
    });

    /** Channels are never end-to-end encrypted, so nothing about them may imply confidentiality. */
    readonly showChannelNotice = this.isChannel;

    private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
    /** Whether new rows should pull the view down. False once the user scrolls up to read back. */
    private pinToBottom = true;
    /** Set once the opening scroll has actually landed on the newest message. */
    private atNewest = false;

    readonly arrowLeftIcon = ArrowLeft;
    readonly infoIcon = Info;
    readonly shieldIcon = Shield;
    readonly shieldAlertIcon = ShieldAlert;
    readonly shieldOffIcon = ShieldOff;
    readonly skipForwardIcon = SkipForward;
    readonly refreshIcon = RefreshCw;
    readonly alertIcon = AlertTriangle;
    readonly usersIcon = Users;
    readonly messageSquareIcon = MessageSquare;
    readonly closeIcon = X;
    readonly replyIcon = Reply;
    readonly editIcon = Pencil;
    readonly forwardIcon = Forward;
    readonly trashIcon = Trash2;
    readonly pinIcon = Pin;
    readonly pinOffIcon = PinOff;

    quotedName(message: DecryptedMessage): string {
        return this.directory.isMe(message.senderId) ? 'yourself' : this.directory.lookup(message.senderId).name;
    }

    constructor() {
        effect(() => {
            const id = this.chatId() ?? null;
            this.store.activeChatId.set(id);
            this.bannerDismissed.set(false);
            this.pinnedBannerDismissed.set(false);
            this.pinnedPanelOpen.set(false);
            this.pinToBottom = true;
            this.atNewest = false;
        });

        // Keep the newest message in view.
        //
        // An effect rather than a lifecycle hook: the scroll pane is inside an @if on the loaded
        // chat, so the checks that run before it exists are useless, and the ones after it appears
        // are not guaranteed to coincide with the history arriving. This fires on the signal itself.
        effect(() => {
            const rows = this.conversation().length;

            untracked(() => {
                if (rows > 0 && this.pinToBottom) {
                    this.scrollToBottomAfterRender();
                }
            });
        });
    }

    /**
     * Scroll once the browser has laid the new rows out.
     *
     * Two frames, not one: the first runs before layout has been recalculated for the rows just
     * rendered, so `scrollHeight` is still the old value and scrolling to it lands short.
     */
    private scrollToBottomAfterRender(): void {
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                const element = this.scroller()?.nativeElement;
                if (!element) {
                    return;
                }

                element.scrollTop = element.scrollHeight;
                this.atNewest = true;
            })
        );
    }

    /**
     * A stable identity per row.
     *
     * Index tracking would recycle a bubble onto a different message whenever older history is
     * prepended, which matters now that a bubble carries its own state — its `no_key` grace timer
     * would end up attached to the wrong message.
     */
    /**
     * Present an unsent message in the same shape a delivered one has.
     *
     * We wrote it, so its content is known and its authorship is not in question — status `ok` and
     * `senderVerified` are statements of fact here, not claims about a signature we checked.
     */
    pendingAsMessage(pending: PendingMessage): DecryptedMessage {
        return {
            id: pending.localId,
            chatId: this.chat()?.id ?? '',
            senderId: this.session.user()?.id ?? '',
            createdAt: pending.createdAt,
            text: pending.text,
            status: 'ok',
            isEdited: false,
            replyToId: null,
            forwardedFrom: null,
            attachments: [],
            senderVerified: true,
            reactions: [],
            isPinned: false,
        };
    }

    itemKey(item: ConversationItem, index: number): string {
        switch (item.kind) {
            case 'message':
                return `m:${item.message.id}`;
            case 'pending':
                return `p:${item.pending.localId}`;
            default:
                return `${item.kind}:${index}`;
        }
    }

    /** Loading older pages must not yank the view; only stay pinned if the user already is. */
    onScroll(): void {
        const element = this.scroller()?.nativeElement;

        // Until the opening scroll has landed we are sitting at the top by accident, not by
        // intention. Reading that as "the user scrolled up" would unpin the view and start paging
        // in older history, which is how a freshly opened chat ends up stuck at its beginning.
        if (!element || !this.atNewest) {
            return;
        }

        this.pinToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;

        if (element.scrollTop < 120 && this.hasMoreHistory() && !this.loading()) {
            const before = element.scrollHeight;
            void this.store.loadOlder().then(() => {
                const after = this.scroller()?.nativeElement;
                if (after) {
                    after.scrollTop += after.scrollHeight - before;
                }
            });
        }
    }

    /** How many other participants have read up to this message. Only meaningful on our own sends. */
    readReceipt(message: DecryptedMessage): MessageReadReceipt | null {
        return this.store.readReceipt(message);
    }

    /** The message a reply quotes, if it is among the ones we have loaded and opened. */
    quotedFor(message: DecryptedMessage): DecryptedMessage | null {
        if (!message.replyToId) {
            return null;
        }
        return (
            this.conversation()
                .filter((item) => item.kind === 'message')
                .map((item) => (item as { message: DecryptedMessage }).message)
                .find((candidate) => candidate.id === message.replyToId) ?? null
        );
    }

    /**
     * Build the menu for one message.
     *
     * Composed from what is actually possible rather than shown-then-disabled: copy needs plaintext,
     * editing needs a message we wrote and could open, deleting needs to be ours. An item that would
     * be rejected is worse than an absent one.
     */
    openMessageMenu(request: { message: DecryptedMessage; x: number; y: number }): void {
        const message = request.message;
        const items: ContextMenuItem[] = [{ icon: Reply, label: 'Reply', action: () => this.startReply(message) }];

        if (message.text !== null) {
            items.push({ icon: Copy, label: 'Copy text', action: () => void this.copyText(message) });
        }

        if (this.directory.isMe(message.senderId) && message.status === 'ok') {
            items.push({ icon: Pencil, label: 'Edit', action: () => this.startEdit(message) });
        }

        items.push({ icon: CheckCheck, label: 'Select', action: () => this.store.toggleSelected(message.id) });

        // Server-enforced role gate — this is UX only, so a member simply does not see the option
        // rather than seeing it fail.
        if (this.canPinMessages()) {
            items.push(
                message.isPinned
                    ? { icon: PinOff, label: 'Unpin', action: () => void this.store.unpinMessage(message.id) }
                    : { icon: Pin, label: 'Pin', action: () => void this.store.pinMessage(message.id) }
            );
        }

        if (this.canDelete(message.senderId)) {
            items.push({
                icon: Trash2,
                label: 'Delete',
                danger: true,
                action: () => void this.deleteMessage(message.id),
            });
        }

        this.menuItems.set(items);
        this.menuAnchor.set({ x: request.x, y: request.y });
    }

    closeMenu(): void {
        this.menuAnchor.set(null);
    }

    toggleSelected(messageId: string): void {
        this.store.toggleSelected(messageId);
    }

    /**
     * Press and drag across messages to select a range.
     *
     * The threshold is what keeps this from stealing text selection: nothing happens until the
     * pointer has travelled past it *and* reached a different message. Below that it is an ordinary
     * click, and a small drag inside one message still highlights words as usual. Only a deliberate
     * sweep across messages is read as picking them.
     */
    onListPointerDown(event: MouseEvent): void {
        if (event.button !== 0) {
            return;
        }

        const anchor = this.messageIdAt(event.clientX, event.clientY);
        if (!anchor) {
            return;
        }

        const startY = event.clientY;
        const before = new Set(this.store.selectedIds());
        let dragging = false;

        const onMove = (move: MouseEvent) => {
            const over = this.messageIdAt(move.clientX, move.clientY);
            if (!over) {
                return;
            }

            if (!dragging) {
                if (Math.abs(move.clientY - startY) < DRAG_SELECT_THRESHOLD_PX || over === anchor) {
                    return;
                }
                dragging = true;
                // The browser has already begun highlighting text by now; drop it so the sweep does
                // not leave a selection behind the picked messages.
                window.getSelection()?.removeAllRanges();
            }

            move.preventDefault();
            this.selectRange(before, anchor, over);
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /** Which message the pointer is over, if any. */
    private messageIdAt(x: number, y: number): string | null {
        const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('app-message-bubble');
        return element?.id?.startsWith('msg-') ? element.id.slice(4) : null;
    }

    /**
     * Replace the drag's contribution on every move.
     *
     * Recomputed from the selection as it stood when the drag began, so sweeping back up unselects
     * what overshooting had picked instead of leaving it stuck on.
     */
    private selectRange(before: ReadonlySet<string>, anchorId: string, currentId: string): void {
        const ids = this.conversation()
            .filter((item) => item.kind === 'message')
            .map((item) => (item as { message: DecryptedMessage }).message.id);

        const from = ids.indexOf(anchorId);
        const to = ids.indexOf(currentId);
        if (from < 0 || to < 0) {
            return;
        }

        const span = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        this.store.selectedIds.set(new Set([...before, ...span]));
    }

    cancelSelection(): void {
        this.forwardPickerOpen.set(false);
        this.store.clearSelection();
    }

    async deleteSelected(): Promise<void> {
        await this.store.deleteSelected();
    }

    async forwardTo(targetChatId: string): Promise<void> {
        const sent = await this.store.forwardSelected(targetChatId);
        this.forwardPickerOpen.set(false);

        if (sent === 0) {
            this.store.realtimeError.set('Nothing could be forwarded.');
        }
    }

    titleOfChat(chat: Chat): string {
        return chat.title ?? (chat.chat_type === 'channel' ? 'Channel' : 'Untitled chat');
    }

    private async copyText(message: DecryptedMessage): Promise<void> {
        try {
            await navigator.clipboard.writeText(message.text ?? '');
        } catch {
            this.store.realtimeError.set('Could not copy that message.');
        }
    }

    /**
     * Scroll to a quoted message and flash it.
     *
     * Landing somewhere mid-history without a cue leaves the reader hunting for what moved, so the
     * target is highlighted briefly. Jumping also unpins the view — arriving at an older message and
     * then being dragged back to the newest one would undo the navigation.
     */
    jumpToMessage(messageId: string): void {
        const target = this.scroller()?.nativeElement.querySelector<HTMLElement>(`#msg-${CSS.escape(messageId)}`);
        if (!target) {
            return;
        }

        this.pinToBottom = false;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });

        target.classList.add('is-highlighted');
        setTimeout(() => target.classList.remove('is-highlighted'), 1600);
    }

    startReply(message: DecryptedMessage): void {
        this.editing.set(null);
        this.replyingTo.set(message);
    }

    /** Load the message back into the composer. Sending replaces it rather than posting anew. */
    startEdit(message: DecryptedMessage): void {
        this.replyingTo.set(null);
        this.editing.set(message);
    }

    cancelCompose(): void {
        this.replyingTo.set(null);
        this.editing.set(null);
    }

    async send(composed: ComposedMessage): Promise<void> {
        this.pinToBottom = true;

        const editing = this.editing();
        const replyTo = this.replyingTo();
        this.cancelCompose();

        if (editing) {
            try {
                await this.store.editMessage(editing.id, composed.text);
            } catch {
                this.store.realtimeError.set('Could not edit that message.');
            }
            return;
        }

        await this.store.send(composed.text, replyTo?.id, composed.attachments);
    }

    onTyping(active: boolean): void {
        this.store.sendTyping(active);
    }

    retry(localId: string): void {
        void this.store.retry(localId);
    }

    discard(localId: string): void {
        this.store.discardPending(localId);
    }

    refreshKeys(): void {
        void this.store.refreshKeys();
    }

    async deleteMessage(messageId: string): Promise<void> {
        await this.store.deleteMessage(messageId);
    }

    canDelete(senderId: string): boolean {
        return this.directory.isMe(senderId);
    }

    react(messageId: string, emoji: string): void {
        // The endpoint itself toggles — the same emoji from the same user removes it — so both
        // "add" and "remove your own" go through this one call.
        void this.store.react(messageId, emoji);
    }

    /** The most recently pinned message, for the collapsed banner. */
    readonly latestPinned = computed(() => this.pinnedMessages().at(-1) ?? null);

    dismissPinnedBanner(): void {
        this.pinnedBannerDismissed.set(true);
    }

    openPinnedPanel(): void {
        this.pinnedPanelOpen.set(true);
    }

    closePinnedPanel(): void {
        this.pinnedPanelOpen.set(false);
    }

    jumpToPinned(messageId: string): void {
        this.pinnedPanelOpen.set(false);
        this.jumpToMessage(messageId);
    }

    async unpinFromPanel(messageId: string): Promise<void> {
        await this.store.unpinMessage(messageId);
    }

    async openSafetyNumber(): Promise<void> {
        const chat = this.chat();
        const peer = this.peerId();
        if (chat && peer) {
            await this.router.navigate(['/chats', chat.id, 'safety', peer]);
        }
    }

    async backToList(): Promise<void> {
        await this.router.navigate(['/chats']);
    }
}
