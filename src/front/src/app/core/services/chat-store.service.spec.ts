import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';

import { Chat } from '../models/chat.model';
import { ChatKeys, MessageAttachment, MessageResponse } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { ChatStoreService } from './chat-store.service';
import { CryptoApiService } from './crypto-api.service';
import { RosterVerificationError } from './crypto-errors';
import { DirectoryService } from './directory.service';
import { DecryptedMessage, DecryptStatus, MessageService } from './message.service';
import { SessionService } from './session.service';
import { WebSocketService } from './websocket.service';

const CHAT = 'a0000000-0000-4000-8000-000000000001';

function decrypted(id: string, status: DecryptStatus): DecryptedMessage {
    return {
        id,
        chatId: CHAT,
        senderId: 'peer',
        createdAt: '2026-01-01T00:00:00Z',
        text: status === 'ok' || status === 'plaintext' ? 'text' : null,
        status,
        isEdited: false,
        replyToId: null,
        forwardedFrom: null,
        attachments: [],
        senderVerified: false,
        reactions: [],
        isPinned: false,
    };
}

function chat(overrides: Partial<Chat> = {}): Chat {
    return {
        id: CHAT,
        chat_type: 'group',
        title: 'Dev Team',
        avatar_url: null,
        unread_count: 0,
        last_message: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
        participants: [],
        muted_until: null,
        is_muted: false,
        ...overrides,
    };
}

function messageResponse(overrides: Partial<MessageResponse> = {}): MessageResponse {
    return {
        _id: 'a',
        chat_id: CHAT,
        sender_id: 'peer',
        encrypted_content: null,
        envelope: null,
        channel_post: null,
        content_format: 'sender_keys_v1',
        reply_to_message_id: null,
        forwarded_from: null,
        created_at: '2026-01-01T00:00:00Z',
        attachments: null,
        reactions: [],
        is_read: false,
        is_pinned: false,
        pinned_at: null,
        pinned_by: null,
        is_edited: false,
        is_encrypted: true,
        ...overrides,
    };
}

describe('ChatStoreService', () => {
    let store: ChatStoreService;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                ChatStoreService,
                {
                    provide: ChatApiService,
                    useValue: jasmine.createSpyObj('ChatApiService', [
                        'getChats',
                        'getChat',
                        'toggleReaction',
                        'removeReaction',
                        'pinMessage',
                        'unpinMessage',
                        'getPinnedMessages',
                        'muteChat',
                        'getReadState',
                    ]),
                },
                {
                    provide: CryptoApiService,
                    useValue: jasmine.createSpyObj('CryptoApiService', ['getChatKeys', 'enableEncryption']),
                },
                {
                    provide: MessageService,
                    useValue: jasmine.createSpyObj('MessageService', [
                        'loadMessages',
                        'decrypt',
                        'refreshGrants',
                        'sendText',
                        'sendChannelPost',
                        'recordOutgoing',
                        'patchMeta',
                        'editText',
                    ]),
                },
                {
                    provide: DirectoryService,
                    useValue: jasmine.createSpyObj('DirectoryService', ['resolveMissing', 'rememberPrivateChatPeer']),
                },
                { provide: SessionService, useValue: { user: () => null } },
                {
                    provide: WebSocketService,
                    useValue: {
                        messages: new Subject(),
                        isConnected: () => true,
                        sendRead: () => undefined,
                        sendTyping: () => undefined,
                    },
                },
            ],
        });

        store = TestBed.inject(ChatStoreService);
    });

    describe('conversation', () => {
        /**
         * Group history from before encryption was switched on stays plaintext forever; it is never
         * retroactively sealed. The divider marks where the guarantee actually begins.
         */
        it('places the encryption boundary between the last plaintext and the first sealed message', () => {
            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.messages.set([decrypted('a', 'plaintext'), decrypted('b', 'plaintext'), decrypted('c', 'ok')]);

            const kinds = store.conversation().map((item) => item.kind);
            expect(kinds).toEqual(['message', 'message', 'encryption-boundary', 'message']);
        });

        it('emits no boundary when the whole history is encrypted', () => {
            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.messages.set([decrypted('a', 'ok'), decrypted('b', 'ok')]);

            expect(store.conversation().some((item) => item.kind === 'encryption-boundary')).toBeFalse();
        });

        /** A channel is signed rather than encrypted throughout, so there is no boundary to mark. */
        it('emits no boundary in a channel', () => {
            store.chats.set([chat({ chat_type: 'channel' })]);
            store.activeChatId.set(CHAT);
            store.messages.set([decrypted('a', 'plaintext'), decrypted('b', 'ok')]);

            expect(store.conversation().some((item) => item.kind === 'encryption-boundary')).toBeFalse();
        });

        it('shows the history floor only once there is nothing older to fetch', () => {
            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.chatKeys.set({
                crypto_mode: 'sender_keys_v1',
                history_visibility: 'joined',
                current_epoch: 3,
                my_join_epoch: 2,
                epochs: [{ epoch: 1 }, { epoch: 2 }, { epoch: 3 }],
                distributions: [],
            } as unknown as ChatKeys);
            store.messages.set([decrypted('a', 'ok')]);

            store.hasMoreHistory.set(true);
            expect(store.conversation().some((item) => item.kind === 'history-floor')).toBeFalse();

            store.hasMoreHistory.set(false);
            expect(store.conversation()[0].kind).toBe('history-floor');
        });
    });

    describe('send blocking', () => {
        /** Refusing to distribute keys to an unverifiable roster is the whole point of the check. */
        it('blocks sending when the member set cannot be verified', () => {
            expect(store.canSend()).toBeTrue();

            store.memberVerificationError.set('roster mismatch');

            expect(store.canSend()).toBeFalse();
            expect(store.sendBlockedReason()).toContain('member set');
        });

        /** Falling back to plaintext in a chat believed encrypted is the outcome worth avoiding. */
        it('blocks sending when encryption could not be enabled', () => {
            store.encryptionUnavailable.set('Too many members.');

            expect(store.canSend()).toBeFalse();
            expect(store.sendBlockedReason()).toBe('Too many members.');
        });

        /**
         * Every roster refusal must block, whatever it says.
         *
         * The classifier used to match on the message prefix "Member set verification failed". A
         * binding-signature failure — stronger evidence of a substituted key than a hash mismatch —
         * begins "Roster verification failed", so it silently stopped being recognised: sending
         * carried on and no banner appeared. Asserting over both messages pins the behaviour to the
         * error's type rather than to its wording.
         */
        it('blocks sending for every kind of roster verification failure', async () => {
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;

            for (const message of [
                "Member set verification failed: the server's roster does not match the epoch commitment.",
                'Roster verification failed: device abc presents an identity key that its own signing key does not vouch for.',
                'Roster verification failed: device abc presents a signed prekey without a valid binding signature.',
            ]) {
                store.memberVerificationError.set(null);
                messages.sendText.and.rejectWith(new RosterVerificationError(message));

                // `activeChat` is derived from `chats`, so both have to be set or `send` returns
                // early and the test passes for the wrong reason.
                store.chats.set([chat()]);
                store.activeChatId.set(CHAT);
                await store.send('hello');

                expect(store.canSend()).withContext(`must block on: ${message}`).toBeFalse();
                expect(store.memberVerificationError()).toBe(message);
                // A refusal is not a retryable send: nothing may be left sitting in the composer
                // queue implying it will go out later.
                expect(store.pending().length).withContext('no pending row may survive').toBe(0);
            }
        });
    });

    describe('client_message_id', () => {
        let messages: jasmine.SpyObj<MessageService>;

        beforeEach(() => {
            messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
        });

        const idOfCall = (n: number): string => messages.sendText.calls.argsFor(n)[5] as string;

        it('gives each new message its own id', async () => {
            messages.sendText.and.rejectWith(new Error('offline'));

            await store.send('one');
            await store.send('two');

            const ids = store.pending().map((p) => p.clientMessageId);
            expect(ids[0]).toBeTruthy();
            expect(ids[1]).toBeTruthy();
            expect(ids[0]).not.toBe(ids[1]);
            expect(idOfCall(0)).toBe(ids[0]);
            expect(idOfCall(1)).toBe(ids[1]);
        });

        it('keeps the same id when the user presses Retry on a failed send', async () => {
            messages.sendText.and.rejectWith(new Error('offline'));
            await store.send('hello', 'reply-target');

            const failed = store.pending()[0];
            expect(failed.status).toBe('failed');

            await store.retry(failed.localId);

            expect(messages.sendText).toHaveBeenCalledTimes(2);
            expect(idOfCall(1)).toBe(idOfCall(0));
            expect(store.pending()[0].clientMessageId).toBe(failed.clientMessageId);
            // The retry is the same message, not a stripped copy of it.
            expect(messages.sendText.calls.argsFor(1)[2]).toBe('reply-target');
        });

        it('mints a fresh id on Retry only after IDEMPOTENCY_KEY_REUSED', async () => {
            messages.sendText.and.rejectWith(
                new HttpErrorResponse({ status: 409, error: { error_code: 'IDEMPOTENCY_KEY_REUSED' } })
            );
            await store.send('hello');

            const failed = store.pending()[0];
            expect(failed.status).toBe('failed');
            expect(failed.clientMessageId).not.toBe(idOfCall(0));

            messages.sendText.and.resolveTo(messageResponse({ _id: 'y1' }));
            messages.recordOutgoing.and.returnValue(decrypted('y1', 'ok'));
            await store.retry(failed.localId);

            expect(idOfCall(1)).toBe(failed.clientMessageId);
            expect(idOfCall(1)).not.toBe(idOfCall(0));
        });

        it('accepts the stored message on a replay without duplicating it', async () => {
            const stored = messageResponse({ _id: 'x1', sender_id: 'me' });
            messages.sendText.and.resolveTo(stored);
            messages.recordOutgoing.and.returnValue(decrypted('x1', 'ok'));

            await store.send('hello');
            // A manual retry after the server already stored it: the replayed response is the same
            // document, and the client dedups by message id.
            messages.sendText.and.resolveTo(stored);
            await store.send('hello', undefined, undefined, idOfCall(0));

            expect(idOfCall(1)).toBe(idOfCall(0));
            expect(store.messages().filter((m) => m.id === 'x1').length).toBe(1);
            expect(store.pending().length).toBe(0);
        });
    });

    describe('openChat', () => {
        /**
         * The fix this guards: `openChat` used to let `loadMessages` fetch this chat's keys a
         * second time, immediately after `ensureEncryptionEnabled` had already fetched them. For a
         * non-channel chat, the `ChatKeys` returned by `ensureEncryptionEnabled` (here, via the
         * mocked `cryptoApi.getChatKeys`) must be threaded straight through as `loadMessages`'
         * fourth argument instead of being dropped.
         */
        it('passes the ChatKeys fetched for this chat through to loadMessages as the 4th argument', async () => {
            const chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            const cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;

            const keys: ChatKeys = {
                crypto_mode: 'sender_keys_v1',
                history_visibility: 'joined',
                current_epoch: 1,
                my_join_epoch: 1,
                epochs: [],
                distributions: [],
            };

            chatApi.getChat.and.returnValue(of(chat()));
            cryptoApi.getChatKeys.and.returnValue(of(keys));
            chatApi.getPinnedMessages.and.returnValue(of([]));
            chatApi.getReadState.and.returnValue(of([]));
            messages.loadMessages.and.resolveTo({ raw: [], messages: [] });

            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);

            // Flushes the microtask queue (and the effect's scheduling) so openChat's whole async
            // chain — hydrateChat, ensureEncryptionEnabled, loadMessages — has actually run.
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(messages.loadMessages).toHaveBeenCalledWith(CHAT, 50, undefined, keys);
        });
    });

    describe('editMessage', () => {
        it('threads the caller-supplied attachment list through to MessageService.editText', async () => {
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            const attachment: MessageAttachment = {
                url: 'files/attachments/a/new.png',
                name: 'new.png',
                size: 10,
                content_type: 'image/png',
            };

            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.messages.set([decrypted('a', 'ok')]);
            messages.editText.and.resolveTo({ ...decrypted('a', 'ok'), text: 'edited', attachments: [attachment] });

            await store.editMessage('a', 'edited', [attachment]);

            expect(messages.editText).toHaveBeenCalledWith(CHAT, 'a', 'edited', [attachment]);
        });

        it('falls back to the message’s existing attachments when none are supplied', async () => {
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            const existing = { ...decrypted('a', 'ok'), attachments: [] };

            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.messages.set([existing]);
            messages.editText.and.resolveTo({ ...existing, text: 'edited' });

            await store.editMessage('a', 'edited');

            expect(messages.editText).toHaveBeenCalledWith(CHAT, 'a', 'edited', existing.attachments);
        });
    });

    describe('selection', () => {
        beforeEach(() => {
            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.messages.set([decrypted('a', 'ok'), decrypted('b', 'no_key'), decrypted('c', 'ok')]);
        });

        it('is off until something is picked', () => {
            expect(store.isSelecting()).toBeFalse();

            store.toggleSelected('a');

            expect(store.isSelecting()).toBeTrue();
            expect(store.selectionCount()).toBe(1);
        });

        it('toggles the same message back off', () => {
            store.toggleSelected('a');
            store.toggleSelected('a');

            expect(store.isSelecting()).toBeFalse();
        });

        /**
         * Forwarding re-encrypts plaintext for the target chat, so a message we could not open has
         * nothing to forward. Counting them separately is what lets the UI say so instead of
         * silently dropping them.
         */
        it('counts only readable messages as forwardable', () => {
            store.toggleSelected('a');
            store.toggleSelected('b');

            expect(store.selectionCount()).toBe(2);
            expect(store.forwardableCount()).toBe(1);
        });
    });

    describe('previews', () => {
        it('reports an unopened encrypted chat as sealed rather than blank', () => {
            const preview = store.preview(
                chat({ last_message: { content_format: 'sender_keys_v1' } as MessageResponse })
            );

            expect(preview.readable).toBeFalse();
            expect(preview.text).toBe('Encrypted message');
        });

        it('reads a channel post directly, since channels are not encrypted', () => {
            const preview = store.preview(
                chat({
                    chat_type: 'channel',
                    last_message: {
                        content_format: 'channel_signed_v1',
                        channel_post: { content: 'Server maintenance tonight' },
                    } as MessageResponse,
                })
            );

            expect(preview.readable).toBeTrue();
            expect(preview.text).toBe('Server maintenance tonight');
        });

        it('says so when a chat has no messages at all', () => {
            expect(store.preview(chat()).text).toBe('No messages yet');
        });
    });

    describe('reactions and pins', () => {
        let chatApi: jasmine.SpyObj<ChatApiService>;
        let messages: jasmine.SpyObj<MessageService>;

        beforeEach(() => {
            chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;

            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.messages.set([decrypted('a', 'ok')]);
        });

        /** The endpoint itself toggles, so react() only ever calls the one method. */
        it('patches the message in place after reacting, without re-decrypting', async () => {
            const raw = messageResponse({ _id: 'a', reactions: [{ user_id: 'me', emoji: '👍', created_at: 'now' }] });
            chatApi.toggleReaction.and.returnValue(of(raw));
            messages.patchMeta.and.returnValue({ ...decrypted('a', 'ok'), reactions: raw.reactions, isPinned: false });

            await store.react('a', '👍');

            expect(chatApi.toggleReaction).toHaveBeenCalledWith('a', '👍');
            expect(store.messages()[0].reactions).toEqual(raw.reactions);
        });

        /** A permission refusal must surface, not disappear silently. */
        it('reports PIN_FORBIDDEN as a readable message', async () => {
            chatApi.pinMessage.and.returnValue(
                throwError(
                    () =>
                        new HttpErrorResponse({
                            status: 403,
                            error: { error_code: 'PIN_FORBIDDEN' },
                        })
                )
            );

            await store.pinMessage('a');

            expect(store.realtimeError()).toContain('permission');
        });

        it('reports PIN_LIMIT_REACHED as a readable message', async () => {
            chatApi.pinMessage.and.returnValue(
                throwError(
                    () =>
                        new HttpErrorResponse({
                            status: 400,
                            error: { error_code: 'PIN_LIMIT_REACHED' },
                        })
                )
            );

            await store.pinMessage('a');

            expect(store.realtimeError()).toContain('maximum');
        });

        /** Only an owner/admin may pin in a group; either participant may in a private chat. */
        it('gates pinning by role in a group but not in a private chat', () => {
            store.chats.set([
                chat({ chat_type: 'group', participants: [{ user_id: 'me', role: 'member', joined_at: '' }] }),
            ]);
            expect(store.canPinMessages()).toBeFalse();

            store.chats.set([chat({ chat_type: 'private' })]);
            expect(store.canPinMessages()).toBeTrue();
        });

        it('updates local mute state from the server response', async () => {
            const future = new Date(Date.now() + 86_400_000).toISOString();
            chatApi.muteChat.and.returnValue(of({ chat_id: CHAT, muted_until: future }));

            await store.setMuted(CHAT, future);

            expect(store.chats()[0].is_muted).toBeTrue();
            expect(store.chats()[0].muted_until).toBe(future);
        });
    });

    describe('read receipts', () => {
        const ME = 'me';
        const PEER = 'peer';
        const OTHER = 'other';

        beforeEach(() => {
            const session = TestBed.inject(SessionService) as unknown as { user: () => { id: string } | null };
            session.user = () => ({ id: ME });
        });

        it('reports an unread private-chat message as read by no one', () => {
            store.chats.set([
                chat({
                    chat_type: 'private',
                    participants: [
                        { user_id: ME, role: 'member', joined_at: '' },
                        { user_id: PEER, role: 'member', joined_at: '' },
                    ],
                }),
            ]);
            store.activeChatId.set(CHAT);
            store.readState.set(new Map([[PEER, null]]));

            expect(store.readReceipt(decrypted('b', 'ok'))).toEqual({ readCount: 0, total: 1 });
        });

        /** ObjectId strings sort lexicographically in creation order, so `>=` is the read test. */
        it('reports a private-chat message as read once the peer catches up to it', () => {
            store.chats.set([
                chat({
                    chat_type: 'private',
                    participants: [
                        { user_id: ME, role: 'member', joined_at: '' },
                        { user_id: PEER, role: 'member', joined_at: '' },
                    ],
                }),
            ]);
            store.activeChatId.set(CHAT);
            store.readState.set(new Map([[PEER, 'b']]));

            expect(store.readReceipt(decrypted('a', 'ok'))).toEqual({ readCount: 1, total: 1 });
            expect(store.readReceipt(decrypted('c', 'ok'))).toEqual({ readCount: 0, total: 1 });
        });

        it('counts "read by N of M" across a group, excluding the sender', () => {
            store.chats.set([
                chat({
                    chat_type: 'group',
                    participants: [
                        { user_id: ME, role: 'member', joined_at: '' },
                        { user_id: PEER, role: 'member', joined_at: '' },
                        { user_id: OTHER, role: 'member', joined_at: '' },
                    ],
                }),
            ]);
            store.activeChatId.set(CHAT);
            store.readState.set(
                new Map([
                    [PEER, 'b'],
                    [OTHER, null],
                ])
            );

            expect(store.readReceipt(decrypted('b', 'ok'))).toEqual({ readCount: 1, total: 2 });
        });

        it('advances the read map only for the active chat on a message_read broadcast', () => {
            const ws = TestBed.inject(WebSocketService) as unknown as { messages: Subject<unknown> };
            store.chats.set([chat({ chat_type: 'private' })]);
            store.activeChatId.set(CHAT);
            store.bindRealtime();

            ws.messages.next({
                event_type: 'message_read',
                chat_id: 'some-other-chat',
                user_id: PEER,
                payload: { last_read_message_id: 'z' },
            });
            expect(store.readState().get(PEER)).toBeUndefined();

            ws.messages.next({
                event_type: 'message_read',
                chat_id: CHAT,
                user_id: PEER,
                payload: { last_read_message_id: 'z' },
            });
            expect(store.readState().get(PEER)).toBe('z');
        });

        /**
         * `GET /chats/` always returns `participants: []` (`enrich_chats_with_mongo_data` has no
         * participants key to give). Refreshing the list after a membership change must not clobber
         * the roster a prior `GET /chats/{id}` already hydrated for the open chat — otherwise
         * `readReceipt` loses its "other participants" and read receipts go dark until the chat is
         * reopened.
         */
        it('preserves a hydrated roster across a loadChats() refresh triggered by participants_added', async () => {
            const chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            const ws = TestBed.inject(WebSocketService) as unknown as { messages: Subject<unknown> };

            const hydrated = chat({
                chat_type: 'private',
                participants: [
                    { user_id: ME, role: 'member', joined_at: '' },
                    { user_id: PEER, role: 'member', joined_at: '' },
                ],
            });
            store.chats.set([hydrated]);
            store.activeChatId.set(CHAT);
            store.readState.set(new Map([[PEER, 'b']]));
            store.bindRealtime();

            // The list endpoint's shape: same chat, but with the roster the endpoint never populates.
            chatApi.getChats.and.returnValue(of([chat({ chat_type: 'private', participants: [] })]));

            ws.messages.next({ event_type: 'participants_added', chat_id: CHAT });
            await Promise.resolve();

            expect(store.activeChat()?.participants).toEqual(hydrated.participants);
            expect(store.readReceipt(decrypted('a', 'ok'))).toEqual({ readCount: 1, total: 1 });
        });
    });
});
