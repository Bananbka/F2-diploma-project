import { HttpErrorResponse } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Chat } from '../models/chat.model';
import { ChatKeys, MessageAttachment, MessageResponse } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { CryptoApiService } from './crypto-api.service';
import { isAlreadyEnabled, isCryptoNotEnabled, isEnableForbidden, isEncryptionRefused } from './crypto-errors';
import { DirectoryService } from './directory.service';
import { DecryptedMessage, MessageService } from './message.service';
import { SessionService } from './session.service';
import { WebSocketService } from './websocket.service';

const PAGE_SIZE = 50;

/**
 * Backoff for pulling grants after a `no_key`, in milliseconds.
 *
 * Front-loaded because the common case — a peer who just reloaded and re-published — resolves within
 * a second or two. It then gives up rather than polling forever: a sender who has genuinely not
 * wrapped for this device cannot be made to by asking the server again.
 */
const GRANT_RETRY_DELAYS = [400, 1500, 4000, 10000];

/** A message we are sending. Kept out of the decrypted history until the server accepts it. */
export interface PendingMessage {
    localId: string;
    text: string;
    /** Local send time, so the pending row can show the same stamp the delivered one will. */
    createdAt: string;
    status: 'sending' | 'failed';
    /** True when the failure survived the automatic EPOCH_STALE re-encrypt-and-retry. */
    rekeyFailure: boolean;
}

/**
 * What the message list renders, in order.
 *
 * The dividers are items rather than flags because they belong at a position in the history, not at
 * the top of the pane — the encryption boundary in particular sits between two real messages.
 */
export type ConversationItem =
    | { kind: 'history-floor' }
    | { kind: 'encryption-boundary' }
    | { kind: 'message'; message: DecryptedMessage }
    | { kind: 'pending'; pending: PendingMessage };

/** A sidebar preview. `readable` is false whenever we are not entitled or not yet able to read it. */
export interface ChatPreview {
    text: string;
    readable: boolean;
}

/**
 * The conversation state the UI reads.
 *
 * Most of this service exists to keep the states in `docs/ui-states.md` distinguishable. The
 * temptation in a messenger store is to reduce everything to a list of strings plus an error flag;
 * doing that here would make the interface claim guarantees the protocol does not provide.
 */
@Injectable({ providedIn: 'root' })
export class ChatStoreService {
    private readonly chatApi = inject(ChatApiService);
    private readonly cryptoApi = inject(CryptoApiService);
    private readonly messages_ = inject(MessageService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);
    private readonly ws = inject(WebSocketService);

    readonly chats = signal<Chat[]>([]);
    readonly chatsLoading = signal(false);
    readonly chatsError = signal<string | null>(null);

    readonly activeChatId = signal<string | null>(null);
    readonly activeChat = computed(() => this.chats().find((c) => c.id === this.activeChatId()) ?? null);

    readonly messages = signal<DecryptedMessage[]>([]);
    readonly pending = signal<PendingMessage[]>([]);
    readonly messagesLoading = signal(false);
    readonly hasMoreHistory = signal(false);

    readonly chatKeys = signal<ChatKeys | null>(null);

    /**
     * The client recomputed `member_set_hash` from the roster and it disagreed with the epoch
     * commitment. The server may have inserted a device that would receive future messages, so key
     * distribution is refused and sending is blocked. This is the highest-severity state in the app.
     */
    readonly memberVerificationError = signal<string | null>(null);

    /**
     * Encryption could not be enabled for this chat — the group exceeds the member ceiling that
     * sender-key distribution can carry, or the server refused for another permanent reason.
     *
     * Its own state rather than a generic error: the chat is readable and its history is intact, but
     * nothing new can be sealed. Sending is blocked instead of falling back to plaintext, because a
     * chat the user believes is encrypted must never quietly stop being so.
     */
    readonly encryptionUnavailable = signal<string | null>(null);

    /** A new epoch opened — membership changed and chains are being re-minted. Transient. */
    readonly isRekeying = signal(false);

    readonly typingUserIds = signal<string[]>([]);
    readonly onlineUserIds = signal<string[]>([]);

    /** The last error the socket reported, if any. Cleared when a chat is opened. */
    readonly realtimeError = signal<string | null>(null);

    readonly isOnline = this.ws.isConnected;

    /**
     * Sending is impossible while the member set is in doubt, or while there is no key to seal with.
     * Refusing in both cases is the whole point.
     */
    readonly canSend = computed(() => this.memberVerificationError() === null && this.encryptionUnavailable() === null);

    /** Why sending is blocked, if it is. Ordered by severity. */
    readonly sendBlockedReason = computed<string | null>(() => {
        if (this.memberVerificationError()) {
            return 'Blocked: the member set for this chat could not be verified.';
        }
        if (this.encryptionUnavailable()) {
            return this.encryptionUnavailable();
        }
        return null;
    });

    /**
     * Previews for chats we have opened this session, keyed by chat id.
     *
     * Only these can be shown as text. Decrypting every chat's newest message on list load would
     * mean one grant-ingestion round trip per chat, so an unopened chat honestly reports that its
     * preview is sealed rather than rendering a blank line.
     */
    private readonly previewOverrides = signal(new Map<string, ChatPreview>());

    /**
     * The ciphertext behind each rendered message, kept so an undecryptable one can be retried once
     * its grant arrives. Without it, recovering from `no_key` would mean refetching the history.
     */
    private readonly rawMessages = new Map<string, MessageResponse>();

    /**
     * The history floor.
     *
     * `history_visibility: 'joined'` means the server withheld pre-join ciphertext outright — not
     * just the keys — so that sender, timing, size and reply structure cannot leak. It is permanent,
     * and it is only shown once we have actually paged back to the start of what we can see.
     */
    readonly hasHistoryFloor = computed(() => {
        const keys = this.chatKeys();
        if (!keys || keys.history_visibility !== 'joined' || keys.my_join_epoch === null) {
            return false;
        }
        return keys.epochs.some((epoch) => epoch.epoch < keys.my_join_epoch!);
    });

    readonly conversation = computed<ConversationItem[]>(() => {
        const messages = this.messages();
        const isChannel = this.activeChat()?.chat_type === 'channel';
        const items: ConversationItem[] = [];

        if (this.hasHistoryFloor() && !this.hasMoreHistory()) {
            items.push({ kind: 'history-floor' });
        }

        // Group history from before encryption was switched on stays plaintext forever; it is never
        // retroactively sealed. The boundary marks where the guarantee actually begins.
        let boundaryEmitted = isChannel;
        let sawUnencrypted = false;

        for (const message of messages) {
            const unencrypted = message.status === 'plaintext' || message.status === 'legacy';

            if (!boundaryEmitted && sawUnencrypted && !unencrypted) {
                items.push({ kind: 'encryption-boundary' });
                boundaryEmitted = true;
            }

            sawUnencrypted ||= unencrypted;
            items.push({ kind: 'message', message });
        }

        for (const pending of this.pending()) {
            items.push({ kind: 'pending', pending });
        }

        return items;
    });

    private rekeyTimer: ReturnType<typeof setTimeout> | null = null;
    private grantRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private wsBound = false;

    constructor() {
        // Reloading on chat change keeps the component free of imperative fetch orchestration.
        effect(() => {
            const chatId = this.activeChatId();
            untracked(() => {
                if (chatId) {
                    void this.openChat(chatId);
                } else {
                    this.resetConversation();
                }
            });
        });
    }

    /** Subscribe to the realtime stream once. Safe to call from every shell instantiation. */
    bindRealtime(): void {
        if (this.wsBound) {
            return;
        }
        this.wsBound = true;

        this.ws.messages.subscribe((event) => {
            switch (event.event_type) {
                case 'new_message':
                    void this.onIncomingMessage(event.chat_id, event.payload);
                    break;
                case 'message_edited':
                    void this.onMessageEdited(event.chat_id, event.payload);
                    break;
                case 'message_deleted':
                    this.onMessageDeleted(event.payload);
                    break;
                case 'error':
                    this.onServerError(event.payload);
                    break;
                case 'key_epoch_started':
                    this.onEpochStarted(event.chat_id);
                    break;
                case 'typing_start':
                    this.setTyping(event.chat_id, event.user_id, true);
                    break;
                case 'typing_stop':
                    this.setTyping(event.chat_id, event.user_id, false);
                    break;
                case 'user_online':
                    this.setPresence(event.user_id, true);
                    break;
                case 'user_offline':
                    this.setPresence(event.user_id, false);
                    break;
                case 'chat_created':
                    void this.loadChats();
                    break;
            }
        });
    }

    async loadChats(): Promise<void> {
        this.chatsLoading.set(true);
        this.chatsError.set(null);

        try {
            const chats = await firstValueFrom(this.chatApi.getChats());
            this.chats.set(chats);
            this.warmDirectoryFromChats(chats);
        } catch {
            this.chatsError.set('Could not load your chats.');
        } finally {
            this.chatsLoading.set(false);
        }
    }

    /**
     * A private chat's title is its counterpart's display name, so the chat list doubles as the only
     * id-keyed name source for DM peers.
     */
    private warmDirectoryFromChats(chats: Chat[]): void {
        const me = this.session.user()?.id;

        for (const chat of chats) {
            if (chat.chat_type !== 'private') {
                continue;
            }
            const peer = chat.participants.find((p) => p.user_id !== me);
            if (peer) {
                this.directory.rememberPrivateChatPeer(peer.user_id, chat.title, chat.avatar_url);
            }
        }
    }

    private resetConversation(): void {
        if (this.grantRetryTimer) {
            clearTimeout(this.grantRetryTimer);
            this.grantRetryTimer = null;
        }

        this.rawMessages.clear();
        this.messages.set([]);
        this.pending.set([]);
        this.realtimeError.set(null);
        this.clearSelection();
        this.chatKeys.set(null);
        this.encryptionUnavailable.set(null);
        this.memberVerificationError.set(null);
        this.typingUserIds.set([]);
        this.hasMoreHistory.set(false);
    }

    private async openChat(chatId: string): Promise<void> {
        this.resetConversation();
        this.messagesLoading.set(true);

        try {
            const chat = await this.hydrateChat(chatId);

            // Channels are signed rather than encrypted, so they have no epochs, no roster and no
            // grants. Asking for their keys always 404s.
            if (chat?.chat_type !== 'channel') {
                // Fetched before the history so the roster and grants are in place; otherwise every
                // message from a sender we have not ingested yet would report no_key on first paint.
                this.chatKeys.set(await this.ensureEncryptionEnabled(chatId));
            }

            const { raw, messages: decrypted } = await this.messages_.loadMessages(chatId, PAGE_SIZE);
            raw.forEach((message) => this.rawMessages.set(message._id, message));

            this.messages.set(decrypted);
            this.hasMoreHistory.set(decrypted.length === PAGE_SIZE);
            this.cachePreview(chatId, decrypted);
            this.scheduleGrantRetry(chatId);

            await this.markRead(chatId, decrypted);
        } catch {
            this.messages.set([]);
        } finally {
            this.messagesLoading.set(false);
        }
    }

    /**
     * Fill in the parts of a chat that only `GET /chats/{id}` returns, and merge them into the list.
     *
     * The two endpoints are complementary and neither is sufficient alone. The list computes a
     * display title for private chats but returns `participants: []`, because
     * `enrich_chats_with_mongo_data` builds plain dicts with no participants key and Pydantic falls
     * back to the field default. The detail endpoint has the real roster but a NULL title.
     *
     * Without the merge there is no counterpart id for a private chat, so the safety number — the
     * only defence against a substituted key — would have nothing to point at.
     */
    private async hydrateChat(chatId: string): Promise<Chat | null> {
        try {
            const detail = await firstValueFrom(this.chatApi.getChat(chatId));

            this.chats.update((list) => {
                const index = list.findIndex((c) => c.id === chatId);
                if (index < 0) {
                    return [...list, detail];
                }

                // The list's title wins: it is the resolved counterpart name, and the detail's is null.
                const merged: Chat = {
                    ...detail,
                    title: list[index].title ?? detail.title,
                    unread_count: list[index].unread_count,
                    last_message: list[index].last_message ?? detail.last_message,
                };
                return [...list.slice(0, index), merged, ...list.slice(index + 1)];
            });

            this.warmDirectoryFromChats(this.chats());

            // Names for anyone in this chat we cannot already identify. Awaited so the first paint
            // of the conversation has them, rather than showing ids and correcting itself.
            await this.directory.resolveMissing(detail.participants.map((p) => p.user_id));

            return this.chats().find((c) => c.id === chatId) ?? detail;
        } catch {
            return this.chats().find((c) => c.id === chatId) ?? null;
        }
    }

    /**
     * Fetch the chat's keys, turning encryption on first if it has never been enabled.
     *
     * `POST /chats/private` and `POST /chats/group` do not create a `ChatCryptoSettings` row, so a
     * brand-new chat has no epoch and `GET .../keys` answers 404 CRYPTO_NOT_ENABLED. Enabling on
     * first open is what makes a private chat encrypted from its first message without requiring the
     * creator to have done anything special.
     *
     * A refusal — too many members — is recorded rather than swallowed. Sending stays blocked, which
     * is correct: quietly falling back to plaintext in a chat the user believes is encrypted is the
     * worst outcome available.
     */
    private async ensureEncryptionEnabled(chatId: string): Promise<ChatKeys | null> {
        try {
            return await firstValueFrom(this.cryptoApi.getChatKeys(chatId));
        } catch (error) {
            if (!isCryptoNotEnabled(error)) {
                throw error;
            }
        }

        try {
            await firstValueFrom(this.cryptoApi.enableEncryption(chatId));
        } catch (error) {
            // A race with another device is fine — the row we wanted now exists either way.
            if (isAlreadyEnabled(error)) {
                return firstValueFrom(this.cryptoApi.getChatKeys(chatId));
            }

            if (isEnableForbidden(error)) {
                // A group whose owner has not switched encryption on. Not our failure to report as
                // one: there is nothing here for this user to fix.
                this.encryptionUnavailable.set(
                    'Encryption has not been enabled for this chat. Only its owner can turn it on.'
                );
                return null;
            }

            this.encryptionUnavailable.set(isEncryptionRefused(error) ?? 'Could not enable encryption for this chat.');
            return null;
        }

        return firstValueFrom(this.cryptoApi.getChatKeys(chatId));
    }

    /** Page backwards. ObjectId monotonicity is the ordering key, so the oldest id is the cursor. */
    async loadOlder(): Promise<void> {
        const chatId = this.activeChatId();
        const oldest = this.messages()[0];

        if (!chatId || !oldest || this.messagesLoading()) {
            return;
        }

        this.messagesLoading.set(true);
        try {
            const { raw, messages: older } = await this.messages_.loadMessages(chatId, PAGE_SIZE, oldest.id);
            raw.forEach((message) => this.rawMessages.set(message._id, message));

            this.messages.update((current) => [...older, ...current]);
            this.hasMoreHistory.set(older.length === PAGE_SIZE);
            this.scheduleGrantRetry(chatId);
        } finally {
            this.messagesLoading.set(false);
        }
    }

    /**
     * Send, tracking the outcome as its own state.
     *
     * `MessageService.sendText` already re-encrypts and retries once on EPOCH_STALE — that path is
     * invisible on purpose. Only a failure that survives the retry surfaces, which is what
     * `docs/ui-states.md` asks for.
     */
    async send(text: string, replyTo?: string, attachments?: MessageAttachment[]): Promise<void> {
        const chatId = this.activeChatId();
        const chat = this.activeChat();
        if (!chatId || !chat || (!text.trim() && !attachments?.length)) {
            return;
        }

        const localId = `local-${crypto.randomUUID()}`;
        this.pending.update((p) => [
            ...p,
            { localId, text, createdAt: new Date().toISOString(), status: 'sending', rekeyFailure: false },
        ]);

        try {
            const sent =
                chat.chat_type === 'channel'
                    ? await this.messages_.sendChannelPost(chatId, text)
                    : await this.messages_.sendText(chatId, text, replyTo, attachments);

            this.pending.update((p) => p.filter((item) => item.localId !== localId));
            this.rawMessages.set(sent._id, sent);

            // Bump before recording: bumping clears the preview override, and our own message is one
            // we can always read, so it should end up as the override rather than be wiped by it.
            this.bumpChatPreview(chatId, sent);
            this.appendDecrypted(this.messages_.recordOutgoing(sent, text));
        } catch (error) {
            if (this.isMemberVerificationFailure(error)) {
                // Blocking, not retryable: we refused to hand keys to a roster we cannot verify.
                this.memberVerificationError.set((error as Error).message);
                this.pending.update((p) => p.filter((item) => item.localId !== localId));
                return;
            }

            this.pending.update((p) =>
                p.map((item) =>
                    item.localId === localId
                        ? { ...item, status: 'failed' as const, rekeyFailure: this.looksLikeRekey(error) }
                        : item
                )
            );
        }
    }

    async retry(localId: string): Promise<void> {
        const item = this.pending().find((p) => p.localId === localId);
        if (!item) {
            return;
        }

        this.pending.update((p) => p.filter((entry) => entry.localId !== localId));
        await this.send(item.text);
    }

    discardPending(localId: string): void {
        this.pending.update((p) => p.filter((entry) => entry.localId !== localId));
    }

    /** Ids picked for a bulk action. Empty means selection mode is off. */
    readonly selectedIds = signal(new Set<string>());

    readonly selectionCount = computed(() => this.selectedIds().size);
    readonly isSelecting = computed(() => this.selectedIds().size > 0);

    /** Only messages we could open can be forwarded — forwarding re-encrypts the plaintext. */
    readonly forwardableCount = computed(() => {
        const picked = this.selectedIds();
        return this.messages().filter((m) => picked.has(m.id) && m.text !== null).length;
    });

    /** Only our own messages can be deleted; the server rejects the rest. */
    readonly deletableCount = computed(() => {
        const picked = this.selectedIds();
        return this.messages().filter((m) => picked.has(m.id) && this.directory.isMe(m.senderId)).length;
    });

    toggleSelected(messageId: string): void {
        this.selectedIds.update((current) => {
            const next = new Set(current);
            if (!next.delete(messageId)) {
                next.add(messageId);
            }
            return next;
        });
    }

    clearSelection(): void {
        this.selectedIds.set(new Set());
    }

    /** Delete every selected message of ours, skipping any that are not. */
    async deleteSelected(): Promise<void> {
        const picked = this.selectedIds();
        const mine = this.messages().filter((m) => picked.has(m.id) && this.directory.isMe(m.senderId));

        for (const message of mine) {
            try {
                await this.deleteMessage(message.id);
            } catch {
                this.realtimeError.set('Some messages could not be deleted.');
            }
        }

        this.clearSelection();
    }

    /**
     * Forward the selected messages into another chat.
     *
     * Under E2E this can only be a re-send: the originals are sealed to this chat's keys, so relaying
     * the ciphertext would produce something the recipient cannot open. Each message is decrypted
     * here and encrypted afresh for the target.
     *
     * Two consequences the UI has to be honest about. Only messages we could read can go — there is
     * no plaintext to re-seal otherwise. And the copy is signed by **us**, not the original author,
     * so the attribution is a line of text rather than anything a recipient can verify. That is a
     * property of forwarding under E2E, not a shortcut taken here.
     */
    async forwardSelected(targetChatId: string): Promise<number> {
        const picked = this.selectedIds();
        const target = this.chats().find((c) => c.id === targetChatId);

        const readable = this.messages()
            .filter((m) => picked.has(m.id) && m.text !== null)
            .sort((a, b) => a.id.localeCompare(b.id));

        let sent = 0;
        for (const message of readable) {
            const author = this.directory.isMe(message.senderId) ? 'you' : this.directory.lookup(message.senderId).name;
            const body = `Forwarded from ${author}:\n${message.text}`;

            try {
                if (target?.chat_type === 'channel') {
                    await this.messages_.sendChannelPost(targetChatId, body);
                } else {
                    await this.messages_.sendText(targetChatId, body);
                }
                sent += 1;
            } catch {
                this.realtimeError.set('Some messages could not be forwarded.');
            }
        }

        this.clearSelection();
        return sent;
    }

    /** Edit one of our own messages. Only the sender may, and only in an encrypted chat. */
    async editMessage(messageId: string, text: string): Promise<void> {
        const chatId = this.activeChatId();
        if (!chatId || !text.trim()) {
            return;
        }

        const edited = await this.messages_.editText(chatId, messageId, text.trim());
        this.messages.update((list) => list.map((m) => (m.id === edited.id ? edited : m)));
        this.cachePreview(chatId, [edited]);
    }

    async deleteMessage(messageId: string): Promise<void> {
        await firstValueFrom(this.chatApi.deleteMessage(messageId));
        this.messages.update((list) => list.filter((m) => m.id !== messageId));
    }

    /** Retry key ingestion for a chat — the usual cure for a screen full of `no_key`. */
    async refreshKeys(): Promise<void> {
        const chatId = this.activeChatId();
        if (!chatId) {
            return;
        }

        this.memberVerificationError.set(null);
        await this.openChat(chatId);
    }

    /**
     * Make `no_key` actually resolve on its own, as the UI says it does.
     *
     * A sender mints a fresh chain whenever their in-memory state is gone — after a reload, or when
     * an epoch opens — and publishes it as a new distribution. Their next message carries a `skid` we
     * hold no chain for, so it decrypts to `no_key`, and nothing on the socket announces the new
     * grant. Only pulling it fixes that, which is why the state used to persist until a reload
     * happened to refetch the keys.
     *
     * Retries are bounded and backed off: if a sender genuinely has not wrapped for us yet, no amount
     * of polling will conjure a grant, and a tight loop would just hammer the endpoint.
     */
    private scheduleGrantRetry(chatId: string, attempt = 0): void {
        if (attempt >= GRANT_RETRY_DELAYS.length || !this.messages().some((m) => m.status === 'no_key')) {
            return;
        }

        if (this.grantRetryTimer) {
            clearTimeout(this.grantRetryTimer);
        }

        this.grantRetryTimer = setTimeout(async () => {
            this.grantRetryTimer = null;

            if (this.activeChatId() !== chatId) {
                return;
            }

            try {
                await this.messages_.refreshGrants(chatId);
                await this.redecryptUnreadable(chatId);
            } catch {
                // Offline or a transient failure; the next attempt covers it.
            }

            this.scheduleGrantRetry(chatId, attempt + 1);
        }, GRANT_RETRY_DELAYS[attempt]);
    }

    /** Re-run decryption for messages we could not open, using ciphertext we already hold. */
    private async redecryptUnreadable(chatId: string): Promise<void> {
        // Oldest first. A receiver chain only moves forward, so retrying out of order would consume a
        // later index and make every earlier message permanently unopenable. Message ids are
        // ObjectIds, which sort chronologically — the same ordering key the backend paginates on.
        const stuck = this.messages()
            .filter((m) => m.status === 'no_key' || m.status === 'failed')
            .sort((a, b) => a.id.localeCompare(b.id));

        if (stuck.length === 0) {
            return;
        }

        const reopened = new Map<string, DecryptedMessage>();
        for (const message of stuck) {
            const raw = this.rawMessages.get(message.id);
            if (!raw) {
                continue;
            }

            const retried = await this.messages_.decrypt(chatId, raw);
            if (retried.status !== message.status) {
                reopened.set(message.id, retried);
            }
        }

        if (reopened.size === 0) {
            return;
        }

        this.messages.update((list) => list.map((m) => reopened.get(m.id) ?? m));

        const newest = this.messages().at(-1);
        if (newest) {
            this.cachePreview(chatId, [newest]);
        }
    }

    /**
     * The one-line summary in the chat list.
     *
     * Under E2E a preview is only available when we hold the sender's chain, which in practice means
     * the chat has been opened. Saying so is the point: a blank row would read as "no messages".
     */
    preview(chat: Chat): ChatPreview {
        const override = this.previewOverrides().get(chat.id);
        if (override) {
            return override;
        }

        const last = chat.last_message;
        if (!last) {
            return { text: 'No messages yet', readable: true };
        }

        switch (last.content_format) {
            case 'channel_signed_v1':
                // Readable by design — channels are signed, not encrypted.
                return { text: last.channel_post?.content ?? '', readable: true };
            case 'legacy_plaintext':
                return { text: last.encrypted_content ?? '', readable: true };
            case 'legacy_rsa':
                return { text: 'Unreadable legacy message', readable: false };
            default:
                return { text: 'Encrypted message', readable: false };
        }
    }

    private cachePreview(chatId: string, decrypted: DecryptedMessage[]): void {
        const newest = decrypted.at(-1);
        if (!newest) {
            return;
        }

        this.previewOverrides.update((map) => {
            const next = new Map(map);
            next.set(chatId, {
                text: newest.text ?? this.unreadableLabel(newest),
                readable: newest.text !== null,
            });
            return next;
        });
    }

    private unreadableLabel(message: DecryptedMessage): string {
        switch (message.status) {
            case 'no_key':
                return 'Waiting for keys';
            case 'legacy':
                return 'Unreadable legacy message';
            case 'failed':
                return 'Could not be decrypted';
            default:
                return 'Encrypted message';
        }
    }

    sendTyping(typing: boolean): void {
        const chatId = this.activeChatId();
        if (chatId) {
            this.ws.sendTyping(chatId, typing);
        }
    }

    private async markRead(chatId: string, decrypted: DecryptedMessage[]): Promise<void> {
        const newest = decrypted.at(-1);
        if (!newest) {
            return;
        }

        this.ws.sendRead(chatId, newest.id);
        this.chats.update((list) => list.map((c) => (c.id === chatId ? { ...c, unread_count: 0 } : c)));
    }

    private async onIncomingMessage(chatId: string | null, payload: Record<string, unknown>): Promise<void> {
        const raw = payload as unknown as MessageResponse;
        if (!chatId || !raw?._id) {
            return;
        }

        this.bumpChatPreview(chatId, raw);

        if (chatId !== this.activeChatId()) {
            this.chats.update((list) =>
                list.map((c) => (c.id === chatId ? { ...c, unread_count: c.unread_count + 1 } : c))
            );
            return;
        }

        this.rawMessages.set(raw._id, raw);

        const decrypted = await this.messages_.decrypt(chatId, raw);
        this.appendDecrypted(decrypted);
        this.ws.sendRead(chatId, raw._id);

        // The common no_key case: the sender re-published a chain and this is their first message on
        // it. Pull the new grant rather than leaving the bubble stuck until the user reloads.
        if (decrypted.status === 'no_key') {
            this.scheduleGrantRetry(chatId);
        }
    }

    private appendDecrypted(message: DecryptedMessage): void {
        this.messages.update((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]));
        this.cachePreview(message.chatId, [message]);
    }

    /**
     * A message was edited elsewhere.
     *
     * The edit is sealed under a **fresh** chain index — the server rejects reuse, because repeating
     * a message key would repeat a (key, nonce) pair. So this is a new index to open, not a re-read of
     * one already consumed, and it must not go through the plaintext cache keyed on the old content.
     */
    private async onMessageEdited(chatId: string | null, payload: Record<string, unknown>): Promise<void> {
        const raw = payload as unknown as MessageResponse;
        if (!chatId || !raw?._id || chatId !== this.activeChatId()) {
            return;
        }

        this.rawMessages.set(raw._id, raw);
        this.messages_.forgetOne(raw._id);

        const decrypted = await this.messages_.decrypt(chatId, raw);
        this.messages.update((list) => list.map((m) => (m.id === decrypted.id ? decrypted : m)));

        if (decrypted.status === 'no_key') {
            this.scheduleGrantRetry(chatId);
        }
    }

    /** The socket rejected something we sent. Surfaced rather than dropped on the floor. */
    private onServerError(payload: Record<string, unknown>): void {
        const message = payload['message'] ?? payload['detail'];
        this.realtimeError.set(typeof message === 'string' ? message : 'The server rejected a realtime request.');
    }

    private onMessageDeleted(payload: Record<string, unknown>): void {
        const id = payload['message_id'];
        if (typeof id === 'string') {
            this.messages.update((list) => list.filter((m) => m.id !== id));
        }
    }

    /**
     * A membership change opened a new epoch.
     *
     * The chat is re-keyed by re-reading its keys: our cached sender chain belongs to the closed
     * epoch, and the server will reject anything sealed under it.
     */
    private onEpochStarted(chatId: string | null): void {
        if (!chatId || chatId !== this.activeChatId()) {
            return;
        }

        this.isRekeying.set(true);
        void this.refreshKeys().finally(() => {
            if (this.rekeyTimer) {
                clearTimeout(this.rekeyTimer);
            }
            // Held briefly so the notice is legible rather than a flicker.
            this.rekeyTimer = setTimeout(() => this.isRekeying.set(false), 1500);
        });
    }

    private setTyping(chatId: string | null, userId: string | null, typing: boolean): void {
        if (!userId || chatId !== this.activeChatId()) {
            return;
        }

        this.typingUserIds.update((ids) => {
            const without = ids.filter((id) => id !== userId);
            return typing ? [...without, userId] : without;
        });
    }

    private setPresence(userId: string | null, online: boolean): void {
        if (!userId) {
            return;
        }

        this.onlineUserIds.update((ids) => {
            const without = ids.filter((id) => id !== userId);
            return online ? [...without, userId] : without;
        });
    }

    private bumpChatPreview(chatId: string, raw: MessageResponse): void {
        // The override holds the newest message we actually decrypted. A newer one has just arrived
        // that we have not, so the override is now stale — and leaving it in place is worse than
        // having none, because the row would show old text beside an unread badge, claiming the new
        // message says something it does not. Dropping it falls back to the sealed placeholder,
        // which is the truth: we hold no key for this one yet.
        this.previewOverrides.update((map) => {
            if (!map.has(chatId)) {
                return map;
            }
            const next = new Map(map);
            next.delete(chatId);
            return next;
        });

        this.chats.update((list) => {
            const index = list.findIndex((c) => c.id === chatId);
            if (index < 0) {
                return list;
            }

            const updated = { ...list[index], last_message: raw, updated_at: raw.created_at };
            return [updated, ...list.slice(0, index), ...list.slice(index + 1)];
        });
    }

    private isMemberVerificationFailure(error: unknown): boolean {
        return error instanceof Error && error.message.startsWith('Member set verification failed');
    }

    private looksLikeRekey(error: unknown): boolean {
        // MessageService already re-encrypted and retried once, so an epoch error reaching here
        // means the chat re-keyed twice mid-send. That is the one case worth surfacing.
        return error instanceof HttpErrorResponse && error.status === 409 && error.error?.error_code === 'EPOCH_STALE';
    }
}
