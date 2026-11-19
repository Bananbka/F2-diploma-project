import { HttpErrorResponse } from '@angular/common/http';
import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';

import { computeMemberSetHash } from '../crypto/grants';
import { generateIdentity, IdentityBundle } from '../crypto/identity';
import { b64uEncode } from '../crypto/primitives';
import { Chat } from '../models/chat.model';
import { ChatKeys, ChatRoster, MessageAttachment, MessageResponse, RosterEntry } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import {
    ChatStoreService,
    FORWARD_KEY_CHANGED_NOTICE,
    FORWARD_MEMBERSHIP_NOTICE,
    RECHECK_MEMBERSHIP_NOTICE,
    RECHECK_PUBLISH_NOTICE,
} from './chat-store.service';
import { CryptoApiService } from './crypto-api.service';
import {
    KeyChangedError,
    MemberSetMismatchError,
    MembershipMismatchError,
    MembershipUnconfirmedError,
    RetryLimitExceededError,
    RosterVerificationError,
} from './crypto-errors';
import { DirectoryService } from './directory.service';
import { KeyChangeStateService } from './key-change-state.service';
import { KeyStoreService, MemberExpectation } from './key-store.service';
import { MembershipGuardService } from './membership-guard.service';
import { DecryptedMessage, DecryptStatus, MessageService } from './message.service';
import { PollStoreService } from './poll-store.service';
import { SessionService } from './session.service';
import { ToastService } from './toast.service';
import { TrustStoreService } from './trust-store.service';
import { WebSocketService } from './websocket.service';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const PEER = 'b0000000-0000-4000-8000-000000000002';
const ME = 'c0000000-0000-4000-8000-000000000003';

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
    /** Who is signed in, as `SessionService.user()` reports it. Null (signed out) unless a test sets it. */
    let sessionUser: { id: string } | null;
    let keyStore: jasmine.SpyObj<KeyStoreService>;

    beforeEach(() => {
        localStorage.clear();
        sessionUser = null;
        keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', [
            'expectMembers',
            'invalidateOwnChains',
            'recheckRoster',
            'acknowledgeOwnDevicesAdded',
        ]);
        (keyStore as unknown as { ownDevicesAdded: unknown }).ownDevicesAdded = signal(false);
        TestBed.configureTestingModule({
            providers: [
                ChatStoreService,
                { provide: KeyStoreService, useValue: keyStore },
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
                        'pinChat',
                        'markChatUnread',
                        'clearHistory',
                        'leaveChat',
                        'deleteChat',
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
                        'forgetOne',
                        'editText',
                    ]),
                },
                {
                    provide: DirectoryService,
                    useValue: jasmine.createSpyObj('DirectoryService', [
                        'resolveMissing',
                        'rememberPrivateChatPeer',
                        'markDeleted',
                        'lookup',
                    ]),
                },
                { provide: SessionService, useValue: { user: () => sessionUser } },
                {
                    provide: WebSocketService,
                    useValue: {
                        messages: new Subject(),
                        reconnected: new Subject<void>(),
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

    /**
     * A verified member's key changed. The roster passed every §5.0.2 check, so this is not the
     * member-set alarm — it is the safety number the user compared doing its job. Blocking, and
     * lifted only by the user re-confirming the number, which must resume sending with no reload.
     */
    describe('key change of a verified peer', () => {
        const NUMBER_A = '04672 91834 52017 73649 18293 64751 39082 57164 82031 46918 73052 19374';
        const NUMBER_B = '11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12345 67890';
        let messages: jasmine.SpyObj<MessageService>;
        let trust: TrustStoreService;

        /**
         * What the real key store does when it refuses: record the refusal per chat and the roster
         * observation, then throw. The chat store itself records nothing (one source of truth).
         */
        function refuseWithKeyChange(chatId: string, ownDevicesChanged: boolean): void {
            messages.sendText.and.callFake(async () => {
                const keyChange = TestBed.inject(KeyChangeStateService);
                keyChange.observe(ME, PEER, NUMBER_B, 'roster');
                keyChange.recordRefusal(chatId, ME, PEER, NUMBER_B, NUMBER_A, ownDevicesChanged);
                throw new KeyChangedError(
                    chatId,
                    [{ userId: PEER, current: NUMBER_B, previous: NUMBER_A }],
                    ownDevicesChanged
                );
            });
        }

        beforeEach(() => {
            sessionUser = { id: ME };
            messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            trust = TestBed.inject(TrustStoreService);
            const directory = TestBed.inject(DirectoryService) as jasmine.SpyObj<DirectoryService>;
            directory.lookup.and.callFake((id: string) => ({
                userId: id,
                name: id === PEER ? 'Alice' : 'Someone',
                username: null,
                avatarUrl: null,
                resolved: true,
            }));
            store.chats.set([
                chat({
                    participants: [
                        { user_id: ME, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
                        { user_id: PEER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                    ],
                }),
            ]);
            store.activeChatId.set(CHAT);
            trust.markVerified(ME, PEER, NUMBER_A);
        });

        it('turns KeyChangedError into its own blocking state, distinct from the roster alarm', async () => {
            refuseWithKeyChange(CHAT, false);
            expect(store.canSend()).toBeTrue();

            await store.send('hello');

            expect(store.canSend()).toBeFalse();
            expect(store.keyChangedPeers()).toEqual([PEER]);
            expect(store.memberVerificationError()).withContext('not the roster alarm').toBeNull();
            expect(store.sendBlockedReason()).toBe(
                'The security key of Alice changed. Review their safety number before sending.'
            );
            // G4: the draft survives as a failed row with its own wording, rather than vanishing.
            expect(store.pending().length).withContext('the draft is kept').toBe(1);
            expect(store.pending()[0]).toEqual(
                jasmine.objectContaining({ text: 'hello', status: 'failed', keyChangedFailure: true })
            );
        });

        it('does not reach the API again while the block holds, and resumes once the number is confirmed', async () => {
            refuseWithKeyChange(CHAT, false);
            await store.send('hello');
            expect(messages.sendText).toHaveBeenCalledTimes(1);

            // A cached chain would let this send go out to the substituted device; the store must not try.
            await store.send('again');
            expect(messages.sendText).toHaveBeenCalledTimes(1);
            // Only the first draft's failed row; the blocked second send never became one.
            expect(store.pending().length).toBe(1);

            // Nor may Retry reach the API, or drop the row it is retrying, while the block holds.
            await store.retry(store.pending()[0].localId);
            expect(messages.sendText).toHaveBeenCalledTimes(1);
            expect(store.pending().length).toBe(1);

            // The user compared the new number out of band and accepted it in the safety-number screen.
            trust.markVerified(ME, PEER, NUMBER_B);

            expect(store.keyChangedPeers()).toEqual([]);
            expect(store.canSend()).toBeTrue();
            expect(store.sendBlockedReason()).toBeNull();

            messages.sendText.and.resolveTo(messageResponse({ _id: 'sent', sender_id: ME }));
            messages.recordOutgoing.and.returnValue({ ...decrypted('sent', 'ok'), senderId: ME });
            await store.send('resumed');
            expect(messages.sendText).toHaveBeenCalledTimes(2);
        });

        /** The receive path records the change in the trust store; the block follows without a send. */
        it('blocks as soon as the trust store observes a changed number for a member', () => {
            expect(store.canSend()).toBeTrue();

            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_B);

            expect(store.keyChangedPeers()).toEqual([PEER]);
            expect(store.canSend()).toBeFalse();
        });

        it('ignores a changed number for someone who is not in the open chat', () => {
            const outsider = 'd0000000-0000-4000-8000-000000000004';
            trust.markVerified(ME, outsider, NUMBER_A);
            TestBed.inject(KeyChangeStateService).observe(ME, outsider, NUMBER_B);

            expect(store.keyChangedPeers()).toEqual([]);
            expect(store.canSend()).toBeTrue();
        });

        /**
         * G4: the block must not depend on the server-supplied participant list. If `GET /chats/{id}`
         * failed or left the peer out, the refusal used to leave no banner and no draft.
         */
        it('blocks and names the peer from the refusal itself when the participant list omits them', async () => {
            store.chats.set([chat({ participants: [] })]);
            refuseWithKeyChange(CHAT, false);

            await store.send('hello');

            expect(store.keyChangedPeers()).toEqual([PEER]);
            expect(store.canSend()).toBeFalse();
            expect(store.sendBlockedReason()).toContain('Alice');
            expect(store.pending()[0]?.keyChangedFailure).toBeTrue();

            // Lifted by accepting the number it was refused on, with nothing to clear by hand.
            trust.markVerified(ME, PEER, NUMBER_B);
            expect(store.keyChangedPeers()).toEqual([]);
            expect(store.canSend()).toBeTrue();
        });

        /** Round 2, item 4: "Clear verification" must not be a silent way out of a refusal. */
        it('keeps a refused chat blocked when the verification is cleared instead of a number accepted', async () => {
            refuseWithKeyChange(CHAT, false);
            await store.send('hello');

            trust.forget(ME, PEER);

            expect(store.keyChangedPeers()).toEqual([PEER]);
            expect(store.canSend()).toBeFalse();
            expect(TestBed.inject(KeyChangeStateService).blockingNumber(ME, PEER, CHAT)).toBe(NUMBER_B);
        });

        it('lets Retry resend the kept draft once the new number is accepted', async () => {
            refuseWithKeyChange(CHAT, false);
            await store.send('keep me');
            const [row] = store.pending();

            trust.markVerified(ME, PEER, NUMBER_B);
            messages.sendText.and.resolveTo(messageResponse({ _id: 'sent', sender_id: ME }));
            messages.recordOutgoing.and.returnValue({ ...decrypted('sent', 'ok'), senderId: ME });
            await store.retry(row.localId);

            expect(messages.sendText).toHaveBeenCalledTimes(2);
            expect(messages.sendText.calls.mostRecent().args[1]).toBe('keep me');
            expect(messages.sendText.calls.mostRecent().args[5])
                .withContext('same idempotency key')
                .toBe(row.clientMessageId);
            expect(store.pending()).toEqual([]);
        });

        /** G5: the refusal's numbers are roster observations, so a lookup cannot clear them. */
        it('keeps a refusal that a later lookup shows the old number for', async () => {
            refuseWithKeyChange(CHAT, false);
            await store.send('hello');

            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_A, 'lookup');

            expect(TestBed.inject(KeyChangeStateService).blockingNumber(ME, PEER)).toBe(NUMBER_B);
            expect(store.keyChangedPeers()).toEqual([PEER]);
        });

        /** G6: a change on our own side must not be worded as the peer's. */
        it('words the block as our own device list when the refusal says so', async () => {
            refuseWithKeyChange(CHAT, true);

            await store.send('hello');

            expect(store.ownDevicesChanged()).toBeTrue();
            expect(store.sendBlockedReason()).toContain('Your own device list changed');
            expect(store.sendBlockedReason()).not.toContain('Alice');
        });

        /** G3: a forward is a send into the target chat and gets the same block. */
        describe('forwarding', () => {
            const TARGET = 'e0000000-0000-4000-8000-00000000000e';

            beforeEach(() => {
                store.chats.update((list) => [
                    ...list,
                    chat({
                        id: TARGET,
                        participants: [
                            { user_id: ME, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
                            { user_id: PEER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                        ],
                    }),
                ]);
                store.messages.set([decrypted('m1', 'ok')]);
                store.toggleSelected('m1');
            });

            it('refuses to forward into a chat where a verified member’s key changed', async () => {
                TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_B, 'roster');

                const sent = await store.forwardSelected(TARGET);

                expect(sent).toBe(0);
                expect(messages.sendText).not.toHaveBeenCalled();
                expect(store.realtimeError()).toContain('security key');
                expect(store.selectionCount()).withContext('kept for another try').toBe(1);
            });

            it('records a KeyChangedError from the target and stops', async () => {
                refuseWithKeyChange(TARGET, false);
                store.messages.set([decrypted('m1', 'ok'), decrypted('m2', 'ok')]);
                store.toggleSelected('m2');

                const sent = await store.forwardSelected(TARGET);

                expect(sent).toBe(0);
                expect(messages.sendText).withContext('stops at the first refusal').toHaveBeenCalledTimes(1);
                expect(store.realtimeError()).toBe(FORWARD_KEY_CHANGED_NOTICE);
                expect(TestBed.inject(KeyChangeStateService).blockingNumber(ME, PEER)).toBe(NUMBER_B);
            });

            it('forwards normally when nothing changed', async () => {
                messages.sendText.and.resolveTo(messageResponse({ _id: 'fwd', sender_id: ME }));

                expect(await store.forwardSelected(TARGET)).toBe(1);
                expect(messages.sendText).toHaveBeenCalledTimes(1);
                expect(keyStore.expectMembers).toHaveBeenCalledWith(
                    TARGET,
                    jasmine.objectContaining({ kind: 'group' })
                );
            });

            /** Round 3, A: membership is checked for every target type, before the channel branch. */
            it('publishes nothing into a pinned private chat the server now reports as a channel', async () => {
                TestBed.inject(MembershipGuardService).pinPeer(ME, TARGET, PEER);
                store.chats.update((list) =>
                    list.map((c) => (c.id === TARGET ? { ...c, chat_type: 'channel' as const, participants: [] } : c))
                );

                const sent = await store.forwardSelected(TARGET);

                expect(sent).toBe(0);
                expect(messages.sendChannelPost).not.toHaveBeenCalled();
                expect(messages.sendText).not.toHaveBeenCalled();
                expect(store.realtimeError()).toBe(FORWARD_MEMBERSHIP_NOTICE);
            });

            it('raises the membership alarm when that target is the open chat', async () => {
                TestBed.inject(MembershipGuardService).pinPeer(ME, TARGET, PEER);
                store.chats.update((list) =>
                    list.map((c) => (c.id === TARGET ? { ...c, chat_type: 'channel' as const } : c))
                );
                store.activeChatId.set(TARGET);

                await store.forwardSelected(TARGET);

                expect(store.memberVerificationCode()).toBe('MEMBERSHIP_MISMATCH');
                expect(messages.sendChannelPost).not.toHaveBeenCalled();
            });

            it('refuses a channel post into a pinned chat even if the membership check is bypassed', async () => {
                const guard = TestBed.inject(MembershipGuardService);
                guard.pinPeer(ME, TARGET, PEER);
                spyOn(guard, 'register');
                store.chats.update((list) =>
                    list.map((c) => (c.id === TARGET ? { ...c, chat_type: 'channel' as const } : c))
                );

                const sent = await store.forwardSelected(TARGET);

                expect(sent).toBe(0);
                expect(messages.sendChannelPost).not.toHaveBeenCalled();
                expect(store.realtimeError()).toBe(FORWARD_MEMBERSHIP_NOTICE);
            });

            /** S2: a group target once seen as encrypted never receives a readable post. */
            it('publishes nothing into an encrypted group the server now reports as a channel', async () => {
                TestBed.inject(MembershipGuardService).noteEncrypted(TARGET, 'group');
                store.chats.update((list) =>
                    list.map((c) => (c.id === TARGET ? { ...c, chat_type: 'channel' as const } : c))
                );

                const sent = await store.forwardSelected(TARGET);

                expect(sent).toBe(0);
                expect(messages.sendChannelPost).not.toHaveBeenCalled();
                expect(store.realtimeError()).toBe(FORWARD_MEMBERSHIP_NOTICE);
            });

            it('refuses a channel post into an encrypted group even if the membership check is bypassed', async () => {
                const guard = TestBed.inject(MembershipGuardService);
                guard.noteEncrypted(TARGET, 'group');
                spyOn(guard, 'register');
                store.chats.update((list) =>
                    list.map((c) => (c.id === TARGET ? { ...c, chat_type: 'channel' as const } : c))
                );

                expect(await store.forwardSelected(TARGET)).toBe(0);
                expect(messages.sendChannelPost).not.toHaveBeenCalled();
            });

            it('stops at the first roster refusal instead of trying every message', async () => {
                messages.sendText.and.rejectWith(new RosterVerificationError('Roster verification failed: x'));
                store.messages.set([decrypted('m1', 'ok'), decrypted('m2', 'ok')]);
                store.toggleSelected('m2');

                expect(await store.forwardSelected(TARGET)).toBe(0);
                expect(messages.sendText).toHaveBeenCalledTimes(1);
                expect(store.realtimeError()).toBe(FORWARD_MEMBERSHIP_NOTICE);
            });
        });

        /** Round 3, C: the banner's "Re-check" re-runs the roster check, which no send can while blocked. */
        describe('re-check', () => {
            it('re-runs the roster check for the current epoch', async () => {
                const cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
                cryptoApi.getChatKeys.and.returnValue(of({ current_epoch: 4 } as ChatKeys));
                keyStore.recheckRoster.and.resolveTo();

                await store.recheckKeyChange();

                expect(keyStore.recheckRoster).toHaveBeenCalledOnceWith(CHAT, 4);
                expect(store.realtimeError()).toBeNull();
            });

            it('lifts the block once the re-check clears the refusal', async () => {
                refuseWithKeyChange(CHAT, false);
                await store.send('hello');
                expect(store.canSend()).toBeFalse();

                // The user confirms a different number (N2); the re-check finds the roster derives it.
                const N2 = '33333 44444 55555 66666 77777 88888 99999 00000 11111 22222 34567 89012';
                trust.markVerified(ME, PEER, N2);
                const cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
                cryptoApi.getChatKeys.and.returnValue(of({ current_epoch: 1 } as ChatKeys));
                keyStore.recheckRoster.and.callFake(async () => {
                    TestBed.inject(KeyChangeStateService).clearRefusal(CHAT, ME, PEER);
                    TestBed.inject(KeyChangeStateService).observe(ME, PEER, N2, 'roster');
                });

                await store.recheckKeyChange();

                expect(store.keyChangedPeers()).toEqual([]);
                expect(store.canSend()).toBeTrue();
            });

            it('raises the roster alarm if the re-check finds an inconsistent roster', async () => {
                const cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
                cryptoApi.getChatKeys.and.returnValue(of({ current_epoch: 1 } as ChatKeys));
                keyStore.recheckRoster.and.rejectWith(new MemberSetMismatchError('Member set verification failed'));

                await store.recheckKeyChange();

                expect(store.memberVerificationCode()).toBe('MEMBER_SET_MISMATCH');
            });

            /** C6: a re-check that could not confirm membership says so, as a failed send row does. */
            it('says the members could not be confirmed when that is why the re-check failed', async () => {
                const cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
                cryptoApi.getChatKeys.and.returnValue(of({ current_epoch: 1 } as ChatKeys));
                keyStore.recheckRoster.and.rejectWith(new MembershipUnconfirmedError());

                await store.recheckKeyChange();

                expect(store.realtimeError()).toBe(RECHECK_MEMBERSHIP_NOTICE);
                expect(store.memberVerificationError()).withContext('not an alarm').toBeNull();
            });

            it('says the key could not be shared when publishing kept failing', async () => {
                const cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
                cryptoApi.getChatKeys.and.returnValue(of({ current_epoch: 1 } as ChatKeys));
                keyStore.recheckRoster.and.rejectWith(new RetryLimitExceededError(3, null));

                await store.recheckKeyChange();

                expect(store.realtimeError()).toBe(RECHECK_PUBLISH_NOTICE);
            });
        });
    });

    /** Round 3, I: an edit while sending is blocked throws, so the caller can say so. */
    it('throws instead of silently dropping an edit while sending is blocked', async () => {
        store.chats.set([chat()]);
        store.activeChatId.set(CHAT);
        store.memberVerificationError.set('roster mismatch');

        await expectAsync(store.editMessage('m1', 'new text')).toBeRejectedWithError('sending is blocked');
        expect(TestBed.inject(MessageService).editText).not.toHaveBeenCalled();
    });

    /** Round 3, M: a chat this client just created is pinned to the person the user chose. */
    describe('adoptCreatedPrivateChat', () => {
        const OTHER = 'f0000000-0000-4000-8000-00000000000f';
        const created = (...ids: string[]) =>
            chat({
                chat_type: 'private',
                participants: ids.map((user_id) => ({
                    user_id,
                    role: 'member' as const,
                    joined_at: '2026-01-01T00:00:00Z',
                })),
            });

        beforeEach(() => (sessionUser = { id: ME }));

        it('pins the chosen person', () => {
            store.adoptCreatedPrivateChat(created(ME, PEER), PEER);

            expect(TestBed.inject(MembershipGuardService).pinnedPeer(ME, CHAT)).toBe(PEER);
        });

        it('pins the chosen person even when the response carries no participants', () => {
            store.adoptCreatedPrivateChat(created(), PEER);

            expect(TestBed.inject(MembershipGuardService).pinnedPeer(ME, CHAT)).toBe(PEER);
        });

        it('refuses a response naming someone else, or not being a private chat, and pins nothing', () => {
            expect(() => store.adoptCreatedPrivateChat(created(ME, OTHER), PEER)).toThrowError(MembershipMismatchError);
            expect(() => store.adoptCreatedPrivateChat(chat({ chat_type: 'group' }), PEER)).toThrowError(
                MembershipMismatchError
            );
            expect(TestBed.inject(MembershipGuardService).pinnedPeer(ME, CHAT)).toBeNull();
        });

        it('refuses when an existing pin names someone else', () => {
            TestBed.inject(MembershipGuardService).pinPeer(ME, CHAT, OTHER);

            expect(() => store.adoptCreatedPrivateChat(created(), PEER)).toThrowError(MembershipMismatchError);
        });
    });

    /**
     * G1: the key store refuses a roster naming anyone outside the chat, so the store must tell it
     * who that is — from the chat as opened, never from the roster being checked.
     */
    describe('member expectations', () => {
        const OTHER = 'f0000000-0000-4000-8000-00000000000f';

        beforeEach(() => {
            sessionUser = { id: ME };
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            messages.sendText.and.resolveTo(messageResponse({ _id: 'sent', sender_id: ME }));
            messages.recordOutgoing.and.returnValue({ ...decrypted('sent', 'ok'), senderId: ME });
        });

        it('pins a private chat to exactly me and the counterpart', async () => {
            store.chats.set([
                chat({
                    chat_type: 'private',
                    participants: [
                        { user_id: ME, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                        { user_id: PEER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                    ],
                }),
            ]);
            store.activeChatId.set(CHAT);

            await store.send('hello');

            expect(keyStore.expectMembers).toHaveBeenCalledOnceWith(CHAT, {
                kind: 'private',
                selfId: ME,
                peerId: PEER,
            });
        });

        it('keeps a failed row worded as unconfirmed membership for a mis-shaped private chat', async () => {
            store.chats.set([
                chat({
                    chat_type: 'private',
                    participants: [
                        { user_id: ME, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                        { user_id: PEER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                        { user_id: OTHER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                    ],
                }),
            ]);
            store.activeChatId.set(CHAT);

            await store.send('hello');

            // The store must not pick a peer for it, and must not send: an honest, retryable row with
            // its own wording rather than a bare "Send failed." (round 2, item 10).
            expect(keyStore.expectMembers).not.toHaveBeenCalled();
            expect(TestBed.inject(MessageService).sendText).not.toHaveBeenCalled();
            expect(store.pending()[0]).toEqual(
                jasmine.objectContaining({ status: 'failed', membershipFailure: true, text: 'hello' })
            );
            expect(store.memberVerificationError()).withContext('not an alarm').toBeNull();
        });

        const privateWith = (...ids: string[]) =>
            chat({
                chat_type: 'private',
                participants: ids.map((user_id) => ({
                    user_id,
                    role: 'member' as const,
                    joined_at: '2026-01-01T00:00:00Z',
                })),
            });

        /** Round 2, item 2: the pin survives a reload, so the server cannot name a new peer then. */
        it('persists the private counterpart and refuses a different one later, even in a fresh session', async () => {
            store.chats.set([privateWith(ME, PEER)]);
            store.activeChatId.set(CHAT);
            await store.send('hello');
            expect(TestBed.inject(MembershipGuardService).pinnedPeer(ME, CHAT)).toBe(PEER);
            expect(localStorage.getItem('ns.private_peers')).toContain(PEER);

            // "Reload": a brand-new trust store reads the pin back from storage.
            const reloaded = Injector.create({
                parent: TestBed.inject(Injector),
                providers: [MembershipGuardService],
            }).get(MembershipGuardService);
            expect(reloaded.pinnedPeer(ME, CHAT)).toBe(PEER);

            store.chats.set([privateWith(ME, OTHER)]);
            await store.send('to the wrong person');

            expect(store.memberVerificationCode()).toBe('MEMBERSHIP_MISMATCH');
            expect(store.canSend()).toBeFalse();
            expect(TestBed.inject(MessageService).sendText).toHaveBeenCalledTimes(1);
        });

        /** Round 2, item 1: a pinned private chat reported as a group must not get a group expectation. */
        it('raises the membership alarm when a pinned private chat is reported as a group', async () => {
            store.chats.set([privateWith(ME, PEER)]);
            store.activeChatId.set(CHAT);
            await store.send('hello');
            keyStore.expectMembers.calls.reset();

            store.chats.set([
                chat({
                    chat_type: 'group',
                    participants: [
                        { user_id: ME, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
                        { user_id: PEER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                        { user_id: OTHER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                    ],
                }),
            ]);
            await store.send('now a group?');

            expect(keyStore.expectMembers).not.toHaveBeenCalled();
            expect(store.memberVerificationCode()).toBe('MEMBERSHIP_MISMATCH');
            expect(store.memberVerificationError()).toContain('private chat');
        });

        it('raises the same alarm instead of posting in the clear when a pinned private chat becomes a channel', async () => {
            store.chats.set([privateWith(ME, PEER)]);
            store.activeChatId.set(CHAT);
            await store.send('hello');

            store.chats.set([chat({ chat_type: 'channel' })]);
            await store.send('now a channel?');

            expect(TestBed.inject(MessageService).sendChannelPost).not.toHaveBeenCalled();
            expect(store.memberVerificationCode()).toBe('MEMBERSHIP_MISMATCH');
        });

        /** S2: a group is never pinned, so being seen as encrypted is what protects it. */
        it('raises the alarm instead of posting in the clear when an encrypted group becomes a channel', async () => {
            store.chats.set([chat({ chat_type: 'group' })]);
            store.activeChatId.set(CHAT);
            await store.send('hello');

            store.chats.set([chat({ chat_type: 'channel' })]);
            await store.send('now a channel?');

            expect(TestBed.inject(MessageService).sendChannelPost).not.toHaveBeenCalled();
            expect(store.memberVerificationCode()).toBe('MEMBERSHIP_MISMATCH');
            expect(store.memberVerificationError()).toContain('encrypted group');
        });

        it('remembers an encrypted group across a reload', async () => {
            store.chats.set([chat({ chat_type: 'group' })]);
            store.activeChatId.set(CHAT);
            await store.send('hello');

            const reloaded = Injector.create({
                parent: TestBed.inject(Injector),
                providers: [MembershipGuardService],
            }).get(MembershipGuardService);

            expect(reloaded.encryptedTypeOf(CHAT)).toBe('group');
        });

        it('still posts to a chat only ever seen as a channel', async () => {
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            messages.sendChannelPost.and.resolveTo(messageResponse({ _id: 'post', sender_id: ME }));
            store.chats.set([chat({ chat_type: 'channel' })]);
            store.activeChatId.set(CHAT);

            await store.send('hello');

            expect(messages.sendChannelPost).toHaveBeenCalledTimes(1);
            expect(store.memberVerificationError()).toBeNull();
        });

        it('raises the alarm on open, not just on send, when the chat contradicts its pin', async () => {
            const chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            TestBed.inject(MembershipGuardService).pinPeer(ME, CHAT, PEER);
            store.chats.set([privateWith()]);
            store.activeChatId.set(CHAT);
            chatApi.getChat.and.returnValue(of(privateWith(ME, OTHER)));

            await (store as unknown as { hydrateChat(id: string): Promise<unknown> }).hydrateChat(CHAT);

            expect(store.memberVerificationCode()).toBe('MEMBERSHIP_MISMATCH');
        });

        it('lets the key store re-read a group participant list on every publish', async () => {
            const chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            store.chats.set([chat({ chat_type: 'group' })]);
            store.activeChatId.set(CHAT);

            await store.send('hello');

            const expectation = keyStore.expectMembers.calls.mostRecent().args[1] as MemberExpectation;
            expect(expectation.kind).toBe('group');
            chatApi.getChat.and.returnValue(
                of(
                    chat({
                        participants: [
                            { user_id: ME, role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
                            { user_id: OTHER, role: 'member', joined_at: '2026-01-01T00:00:00Z' },
                        ],
                    })
                )
            );
            expect(expectation.kind === 'group' && (await expectation.resolve())).toEqual([ME, OTHER]);
            // Round 2, item 3: what was checked is what the member list shows.
            expect(store.activeChat()?.participants.map((p) => p.user_id)).toEqual([ME, OTHER]);
            expect(TestBed.inject(DirectoryService).resolveMissing).toHaveBeenCalledWith([ME, OTHER]);
        });

        it('registers nothing for a channel, which has no roster', async () => {
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            messages.sendChannelPost.and.resolveTo(messageResponse({ _id: 'post', sender_id: ME }));
            store.chats.set([chat({ chat_type: 'channel' })]);
            store.activeChatId.set(CHAT);

            await store.send('hello');

            expect(keyStore.expectMembers).not.toHaveBeenCalled();
        });
    });

    it('refuses an attachment send in a channel instead of publishing an empty post', async () => {
        store.chats.set([chat({ chat_type: 'channel' })]);
        store.activeChatId.set(CHAT);
        await store.send('', undefined, [
            { url: 'http://x/y', name: 'a.png', size: 1, content_type: 'image/png', kind: 'image' },
        ]);
        expect(TestBed.inject(MessageService).sendChannelPost).not.toHaveBeenCalled();
        expect(store.pending().length).toBe(0);
        expect(store.realtimeError()).toContain('Channels cannot carry attachments');
    });

    /**
     * A private chat whose peer deleted their account is read-only: the history still opens and
     * verifies, nothing new can be sent. It is its own state, not the member-set alarm or the
     * encryption-unavailable limit.
     */
    describe('deleted peer (read-only private chat)', () => {
        let messages: jasmine.SpyObj<MessageService>;

        beforeEach(() => {
            messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
        });

        it('blocks sending and says why when the chat is flagged peer_is_deleted', () => {
            store.chats.set([chat({ chat_type: 'private', peer_is_deleted: true })]);
            store.activeChatId.set(CHAT);

            expect(store.peerDeleted()).toBeTrue();
            expect(store.canSend()).toBeFalse();
            expect(store.sendBlockedReason()).toContain('deleted their account');
        });

        it('leaves an ordinary private chat sendable', () => {
            store.chats.set([chat({ chat_type: 'private' })]);
            store.activeChatId.set(CHAT);

            expect(store.peerDeleted()).toBeFalse();
            expect(store.canSend()).toBeTrue();
        });

        it('never treats a group as read-only because of the flag', () => {
            store.chats.set([chat({ chat_type: 'group', peer_is_deleted: true })]);
            store.activeChatId.set(CHAT);

            expect(store.peerDeleted()).toBeFalse();
        });

        it('keeps the member-set alarm ahead of the deleted-peer notice', () => {
            store.chats.set([chat({ chat_type: 'private', peer_is_deleted: true })]);
            store.activeChatId.set(CHAT);
            store.memberVerificationError.set('roster mismatch');

            expect(store.sendBlockedReason()).toContain('member set');
        });

        it('does not call the API at all while read-only', async () => {
            store.chats.set([chat({ chat_type: 'private', peer_is_deleted: true })]);
            store.activeChatId.set(CHAT);

            await store.send('hello');

            expect(messages.sendText).not.toHaveBeenCalled();
            expect(store.pending().length).toBe(0);
        });

        it('turns a 409 PEER_DELETED into the read-only state, not a retryable failure', async () => {
            store.chats.set([chat({ chat_type: 'private' })]);
            store.activeChatId.set(CHAT);
            messages.sendText.and.rejectWith(
                new HttpErrorResponse({ status: 409, error: { error_code: 'PEER_DELETED' } })
            );

            await store.send('hello');

            expect(store.pending().length).withContext('no failed row to retry').toBe(0);
            expect(store.peerDeleted()).toBeTrue();
            expect(store.canSend()).toBeFalse();
        });

        it('flips the chat read-only on a chat_updated push carrying peer_deleted', () => {
            const ws = TestBed.inject(WebSocketService) as unknown as { messages: Subject<unknown> };
            const directory = TestBed.inject(DirectoryService) as jasmine.SpyObj<DirectoryService>;
            store.chats.set([chat({ chat_type: 'private' })]);
            store.activeChatId.set(CHAT);
            store.bindRealtime();

            ws.messages.next({
                event_type: 'chat_updated',
                chat_id: CHAT,
                user_id: null,
                payload: { peer_deleted: true, user_id: PEER },
            });

            expect(store.peerDeleted()).toBeTrue();
            expect(directory.markDeleted).toHaveBeenCalledWith(PEER);
        });

        it('refetches the list for an ordinary chat_updated push', () => {
            const ws = TestBed.inject(WebSocketService) as unknown as { messages: Subject<unknown> };
            const chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            chatApi.getChats.and.returnValue(of([]));
            store.bindRealtime();

            ws.messages.next({ event_type: 'chat_updated', chat_id: CHAT, user_id: null, payload: { owner_id: PEER } });

            expect(chatApi.getChats).toHaveBeenCalled();
        });

        it('marks the peer deleted in the directory when the list says so', async () => {
            const chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            const directory = TestBed.inject(DirectoryService) as jasmine.SpyObj<DirectoryService>;
            chatApi.getChats.and.returnValue(
                of([
                    chat({
                        chat_type: 'private',
                        title: 'Deleted user',
                        peer_is_deleted: true,
                        participants: [{ user_id: PEER, role: 'member', joined_at: '' }],
                    }),
                ])
            );

            await store.loadChats();

            expect(directory.rememberPrivateChatPeer).toHaveBeenCalledWith(PEER, 'Deleted user', null, true);
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

        it('ends a send that stays EPOCH_STALE as failed with a working Retry, keeping the id', async () => {
            const stale = new HttpErrorResponse({
                status: 409,
                error: { error_code: 'EPOCH_STALE', details: { current_epoch: 3 } },
            });
            // MessageService has already spent its single automatic re-seal when this reaches us.
            messages.sendText.and.rejectWith(stale);
            await store.send('hello');

            const failed = store.pending()[0];
            expect(failed.status).toBe('failed');
            expect(failed.rekeyFailure).toBeTrue();
            expect(failed.clientMessageId).toBe(idOfCall(0));
            // The store must not loop on its own: one call, then it waits for the user.
            expect(messages.sendText).toHaveBeenCalledTimes(1);

            messages.sendText.and.resolveTo(messageResponse({ _id: 'z1' }));
            messages.recordOutgoing.and.returnValue(decrypted('z1', 'ok'));
            await store.retry(failed.localId);

            expect(idOfCall(1)).toBe(failed.clientMessageId);
            expect(store.pending().length).toBe(0);
        });

        it('shows RETRY_LIMIT_EXCEEDED as its own retryable failure, not a roster alarm', async () => {
            messages.sendText.and.rejectWith(new RetryLimitExceededError(3, new Error('503')));
            await store.send('hello');

            const failed = store.pending()[0];
            expect(failed.status).toBe('failed');
            expect(failed.keyPublishFailure).toBeTrue();
            expect(failed.rekeyFailure).toBeFalse();
            expect(store.canSend()).toBeTrue();
            expect(store.memberVerificationError()).toBeNull();
        });

        it('records which roster refusal fired', async () => {
            messages.sendText.and.rejectWith(new MemberSetMismatchError('Member set verification failed'));
            await store.send('a');
            expect(store.memberVerificationCode()).toBe('MEMBER_SET_MISMATCH');

            messages.sendText.and.rejectWith(new RosterVerificationError('Roster verification failed'));
            await store.send('b');
            expect(store.memberVerificationCode()).toBe('ROSTER_VERIFICATION_FAILED');
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

        /** S2: a chat opened with keys is remembered as encrypted, before anything is sent in it. */
        it('records a group opened with keys as encrypted', async () => {
            sessionUser = { id: ME };
            const chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            const cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
            const messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            chatApi.getChat.and.returnValue(of(chat()));
            cryptoApi.getChatKeys.and.returnValue(
                of({ current_epoch: 1, epochs: [], distributions: [] } as unknown as ChatKeys)
            );
            chatApi.getPinnedMessages.and.returnValue(of([]));
            chatApi.getReadState.and.returnValue(of([]));
            messages.loadMessages.and.resolveTo({ raw: [], messages: [] });
            const guard = TestBed.inject(MembershipGuardService);
            expect(guard.encryptedTypeOf(CHAT)).toBeNull();

            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(guard.encryptedTypeOf(CHAT)).toBe('group');
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

    describe('chat list arrangement (pin, mark unread, clear history)', () => {
        let chatApi: jasmine.SpyObj<ChatApiService>;
        let toast: ToastService;

        beforeEach(() => {
            chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            toast = TestBed.inject(ToastService);
            store.chats.set([chat()]);
        });

        it('pins optimistically and keeps the server pin time', async () => {
            chatApi.pinChat.and.returnValue(of({ chat_id: CHAT, pinned_at: '2026-02-02T00:00:00Z' }));

            const pending = store.setPinned(CHAT, true);
            expect(store.chats()[0].is_pinned).toBeTrue();
            await pending;

            expect(chatApi.pinChat).toHaveBeenCalledWith(CHAT, true);
            expect(store.chats()[0].pinned_at).toBe('2026-02-02T00:00:00Z');
        });

        it('rolls back a refused pin and explains the limit', async () => {
            chatApi.pinChat.and.returnValue(
                throwError(() => new HttpErrorResponse({ status: 409, error: { error_code: 'PINNED_CHAT_LIMIT' } }))
            );

            await store.setPinned(CHAT, true);

            expect(store.chats()[0].is_pinned).toBeFalse();
            expect(toast.toasts()[0].message).toContain('up to 5');
        });

        it('marks unread optimistically and rolls back on failure', async () => {
            chatApi.markChatUnread.and.returnValue(throwError(() => new Error('boom')));

            await store.setMarkedUnread(CHAT, true);

            expect(store.chats()[0].marked_unread).toBeFalse();
            expect(toast.toasts().length).toBe(1);
        });

        it('applies pin, unread and history-cleared echoes from another device without refetching', () => {
            const ws = TestBed.inject(WebSocketService) as unknown as { messages: Subject<unknown> };
            store.bindRealtime();
            store.chats.set([chat({ unread_count: 3, last_message: messageResponse({ _id: 'aaa' }) })]);

            ws.messages.next({
                event_type: 'chat_updated',
                chat_id: CHAT,
                user_id: null,
                payload: { pinned: true, pinned_at: '2026-03-03T00:00:00Z' },
            });
            ws.messages.next({
                event_type: 'chat_updated',
                chat_id: CHAT,
                user_id: null,
                payload: { marked_unread: true },
            });
            expect(store.chats()[0].is_pinned).toBeTrue();
            expect(store.chats()[0].pinned_at).toBe('2026-03-03T00:00:00Z');
            expect(store.chats()[0].marked_unread).toBeTrue();

            ws.messages.next({
                event_type: 'chat_updated',
                chat_id: CHAT,
                user_id: null,
                payload: { history_cleared: true, floor: 'bbb' },
            });
            expect(store.chats()[0].last_message).toBeNull();
            expect(store.chats()[0].unread_count).toBe(0);
            expect(store.chats()[0].marked_unread).toBeFalse();
            expect(chatApi.getChats).not.toHaveBeenCalled();
        });

        it('ignores a pin echo while our own request is in flight, then rolls back to the FIRST snapshot', async () => {
            const ws = TestBed.inject(WebSocketService) as unknown as { messages: Subject<unknown> };
            store.bindRealtime();
            const first = new Subject<{ chat_id: string; pinned_at: string | null }>();
            const second = new Subject<{ chat_id: string; pinned_at: string | null }>();
            chatApi.pinChat.and.returnValues(first, second);

            const a = store.setPinned(CHAT, true);
            const b = store.setPinned(CHAT, false);

            // An echo of the first toggle arrives while both are outstanding: it must not win.
            ws.messages.next({
                event_type: 'chat_updated',
                chat_id: CHAT,
                user_id: null,
                payload: { pinned: true, pinned_at: '2026-04-01T00:00:00Z' },
            });
            expect(store.chats()[0].is_pinned).toBeFalse();

            // The earlier request failing must not undo the later one; the later one failing
            // restores the state from before the first toggle.
            first.error(new Error('late failure'));
            await a;
            expect(store.chats()[0].is_pinned).toBeFalse();
            second.error(new Error('boom'));
            await b;
            expect(store.chats()[0].is_pinned).toBeFalse();
            expect(store.chats()[0].pinned_at ?? null).toBeNull();
        });

        it('lets the last writer win by pin time once nothing is in flight', () => {
            const ws = TestBed.inject(WebSocketService) as unknown as { messages: Subject<unknown> };
            store.bindRealtime();
            store.chats.set([chat({ is_pinned: true, pinned_at: '2026-05-01T00:00:00Z' })]);

            ws.messages.next({
                event_type: 'chat_updated',
                chat_id: CHAT,
                user_id: null,
                payload: { pinned: true, pinned_at: '2026-04-01T00:00:00Z' },
            });
            expect(store.chats()[0].pinned_at).toBe('2026-05-01T00:00:00Z');

            ws.messages.next({
                event_type: 'chat_updated',
                chat_id: CHAT,
                user_id: null,
                payload: { pinned: true, pinned_at: '2026-06-01T00:00:00Z' },
            });
            expect(store.chats()[0].pinned_at).toBe('2026-06-01T00:00:00Z');
        });

        it('takes the manual-unread flag from the server answer, not from opening the chat', async () => {
            chatApi.markChatUnread.and.returnValue(of({ chat_id: CHAT, marked_unread: false }));
            store.chats.set([chat({ marked_unread: true })]);

            await store['markRead'](CHAT, []);

            expect(chatApi.markChatUnread).toHaveBeenCalledWith(CHAT, false);
            expect(store.chats()[0].marked_unread).toBeFalse();
        });

        it('hides cleared messages from the open conversation', async () => {
            chatApi.clearHistory.and.returnValue(of({ chat_id: CHAT, history_start_message_id: 'bbb' }));
            store.activeChatId.set(CHAT);
            store.messages.set([
                { ...decrypted('aaa', 'ok'), id: 'aaa' },
                { ...decrypted('ccc', 'ok'), id: 'ccc' },
            ]);

            await store.clearHistory(CHAT);

            expect(store.messages().map((m) => m.id)).toEqual(['ccc']);
        });

        it('removes a chat from the list once it is left', async () => {
            chatApi.leaveChat.and.returnValue(of({}));

            expect(await store.leaveChat(CHAT)).toBeTrue();

            expect(store.chats()).toEqual([]);
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

    describe('event stream', () => {
        let ws: { messages: Subject<unknown>; reconnected: Subject<void> };
        let chatApi: jasmine.SpyObj<ChatApiService>;
        let messages: jasmine.SpyObj<MessageService>;

        beforeEach(() => {
            ws = TestBed.inject(WebSocketService) as unknown as typeof ws;
            chatApi = TestBed.inject(ChatApiService) as jasmine.SpyObj<ChatApiService>;
            messages = TestBed.inject(MessageService) as jasmine.SpyObj<MessageService>;
            chatApi.getChats.and.returnValue(of([chat()]));
            chatApi.getPinnedMessages.and.returnValue(of([]) as never);
            chatApi.getReadState.and.returnValue(of([]) as never);
            messages.loadMessages.and.resolveTo({ raw: [], messages: [] });
            store.chats.set([chat()]);
            store.activeChatId.set(CHAT);
            store.bindRealtime();
            // The session-teardown effect runs once on creation; let it, so it cannot fire mid-test.
            TestBed.flushEffects();
        });

        const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

        it('reloads the chat list and open conversation on resync_required', async () => {
            chatApi.getChats.calls.reset();
            messages.loadMessages.calls.reset();

            ws.messages.next({
                event_type: 'resync_required',
                payload: { reason: 'stream_gap', cursor: '5-0' },
            });
            await settle();

            expect(chatApi.getChats).toHaveBeenCalledTimes(1);
            expect(messages.loadMessages).toHaveBeenCalled();
        });

        it('treats an unknown resync reason like any other resync', async () => {
            chatApi.getChats.calls.reset();
            ws.messages.next({ event_type: 'resync_required', payload: { reason: 'something_new', cursor: null } });
            await settle();
            expect(chatApi.getChats).toHaveBeenCalledTimes(1);
        });

        it('still reloads over HTTP after a plain reconnect', async () => {
            chatApi.getChats.calls.reset();
            ws.reconnected.next();
            await settle();
            expect(chatApi.getChats).toHaveBeenCalledTimes(1);
        });

        it('does not duplicate a replayed message', async () => {
            messages.decrypt.and.resolveTo(decrypted('64b000000000000000000001', 'ok'));
            const frame = {
                event_type: 'new_message',
                chat_id: CHAT,
                stream_id: '10-0',
                payload: { _id: '64b000000000000000000001' },
            };

            ws.messages.next(frame);
            await settle();
            ws.messages.next(frame);
            await settle();

            expect(store.messages().filter((m) => m.id === '64b000000000000000000001').length).toBe(1);
        });

        const ID = '64b000000000000000000009';
        const created = { event_type: 'new_message', chat_id: CHAT, payload: { _id: ID } };
        const edited = { event_type: 'message_edited', chat_id: CHAT, payload: { _id: ID } };
        const deleted = { event_type: 'message_deleted', chat_id: CHAT, payload: { message_id: ID } };

        it('applies a replayed create, edit and delete in order, ending with the message gone', async () => {
            const order: string[] = [];
            messages.decrypt.and.callFake(async () => {
                order.push('decrypt');
                // The first decrypt is slower than the events behind it.
                await new Promise((resolve) => setTimeout(resolve, order.length === 1 ? 30 : 1));
                return { ...decrypted(ID, 'ok'), text: `v${order.length}` };
            });

            ws.messages.next(created);
            ws.messages.next(edited);
            ws.messages.next(deleted);
            // Wait for the per-chat chain itself, not for a guessed duration.
            await store.whenIdle();

            expect(order).toEqual(['decrypt', 'decrypt']);
            expect(store.messages().some((m) => m.id === ID)).toBeFalse();
        });

        it('ignores a decrypt that finishes after the message was deleted', async () => {
            let release!: () => void;
            messages.decrypt.and.callFake(
                () => new Promise((resolve) => (release = () => resolve(decrypted(ID, 'ok'))))
            );

            ws.messages.next(created);
            await settle();
            ws.messages.next(deleted);
            release();
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(store.messages().some((m) => m.id === ID)).toBeFalse();
        });

        it('does not resurrect a deleted message from a late replay of its creation', async () => {
            messages.decrypt.and.resolveTo(decrypted(ID, 'ok'));

            ws.messages.next(deleted);
            await settle();
            ws.messages.next(created);
            await settle();

            expect(store.messages().some((m) => m.id === ID)).toBeFalse();
            expect(messages.decrypt).not.toHaveBeenCalled();
        });

        it('does not count a replayed message twice towards unread in a closed chat', async () => {
            store.activeChatId.set(null);
            store.chats.set([chat({ unread_count: 0 })]);
            const frame = {
                event_type: 'new_message',
                chat_id: CHAT,
                payload: { _id: '64b000000000000000000002' },
            };

            ws.messages.next(frame);
            ws.messages.next(frame);
            await settle();

            expect(store.chats()[0].unread_count).toBe(1);
        });

        describe('poll control messages', () => {
            it('removes a deleted control message from its poll', async () => {
                const polls = TestBed.inject(PollStoreService);
                spyOn(polls, 'removeControl').and.callThrough();
                spyOn(polls, 'forget').and.callThrough();

                ws.messages.next({
                    event_type: 'message_deleted',
                    chat_id: CHAT,
                    payload: { message_id: '64b0000000000000000000a1' },
                });
                await settle();

                expect(polls.removeControl).toHaveBeenCalledWith('64b0000000000000000000a1');
                expect(polls.forget).toHaveBeenCalledWith('64b0000000000000000000a1');
            });

            it('marks held tallies stale when the open conversation changes', async () => {
                const polls = TestBed.inject(PollStoreService);
                spyOn(polls, 'markAllStale').and.callThrough();

                store.activeChatId.set(null);
                TestBed.flushEffects();

                expect(polls.markAllStale).toHaveBeenCalled();
            });

            const POLL = '64b0000000000000000000a0';
            const VOTE = '64b0000000000000000000a1';
            const controlFrame = {
                event_type: 'new_message',
                chat_id: CHAT,
                payload: { _id: VOTE, is_control: true, poll_message_id: POLL },
            };
            const control = (): DecryptedMessage => ({
                ...decrypted(VOTE, 'ok'),
                text: null,
                isControl: true,
                senderVerified: true,
                content: { kind: 'poll_vote', vote: { pollId: POLL, options: [0] } },
            });

            it('never reaches the message list, the preview or the last message', async () => {
                messages.decrypt.and.resolveTo(control());
                store.chats.set([chat({ last_message: null })]);

                ws.messages.next(controlFrame);
                await settle();

                expect(store.messages().length).toBe(0);
                expect(store.chats()[0].last_message).toBeNull();
                expect(store.preview(store.chats()[0]).text).toBe('No messages yet');
            });

            it('does not count towards unread in a closed chat', async () => {
                store.activeChatId.set(null);
                store.chats.set([chat({ unread_count: 0 })]);

                ws.messages.next(controlFrame);
                await settle();

                expect(store.chats()[0].unread_count).toBe(0);
                expect(messages.decrypt).not.toHaveBeenCalled();
            });

            it('is dropped even when a history page lets one through', async () => {
                const normal = decrypted('64b000000000000000000050', 'ok');
                messages.loadMessages.and.resolveTo({ raw: [], messages: [normal, control()] });

                await store.reloadAfterGap();

                expect(store.messages().map((m) => m.id)).toEqual([normal.id]);
            });
        });

        it('previews an attachment-only message instead of leaving the row blank', async () => {
            const sticker: DecryptedMessage = {
                ...decrypted('64b000000000000000000060', 'ok'),
                text: '',
                attachments: [{ url: 'u', name: 'x', size: 0, content_type: 'image/webp', kind: 'sticker' }],
            };
            messages.decrypt.and.resolveTo(sticker);

            ws.messages.next({
                event_type: 'new_message',
                chat_id: CHAT,
                payload: { _id: sticker.id },
            });
            await settle();

            expect(store.preview(store.chats()[0])).toEqual({ text: 'Sticker', readable: true });
        });

        it('previews a poll and a location by what they are', async () => {
            const poll: DecryptedMessage = {
                ...decrypted('64b000000000000000000061', 'ok'),
                text: null,
                content: {
                    kind: 'poll',
                    poll: {
                        question: 'Lunch?',
                        options: ['a', 'b'],
                        multiple: false,
                        anonymous: false,
                        closesAt: null,
                    },
                },
            };
            messages.decrypt.and.resolveTo(poll);
            ws.messages.next({ event_type: 'new_message', chat_id: CHAT, payload: { _id: poll.id } });
            await settle();
            expect(store.preview(store.chats()[0]).text).toBe('Poll: Lunch?');

            const place: DecryptedMessage = {
                ...decrypted('64b000000000000000000062', 'ok'),
                text: null,
                content: { kind: 'location', location: { lat: 1, lon: 2, accuracy: null, label: null } },
            };
            messages.decrypt.and.resolveTo(place);
            ws.messages.next({ event_type: 'new_message', chat_id: CHAT, payload: { _id: place.id } });
            await settle();
            expect(store.preview(store.chats()[0]).text).toBe('Location');
        });
    });
});

/**
 * One end-to-end check of the membership pin against the real key store, rather than stubs on
 * both sides: a private chat the server re-labels as a group with a third member must never get
 * that member a grant. Refused first by the guard, and by the key store itself as the second line.
 */
describe('ChatStoreService with the real KeyStoreService', () => {
    const DEVICE = 'd1000000-0000-4000-8000-0000000000d1';
    const PEER_DEVICE = 'd2000000-0000-4000-8000-0000000000d2';
    const INTRUDER = 'f0000000-0000-4000-8000-00000000000f';
    const INTRUDER_DEVICE = 'd3000000-0000-4000-8000-0000000000d3';

    function entry(userId: string, deviceId: string, bundle: IdentityBundle): RosterEntry {
        return {
            user_id: userId,
            device_id: deviceId,
            identity_key_id: deviceId,
            identity_public_key: b64uEncode(bundle.identityPublic),
            signing_public_key: b64uEncode(bundle.signingPublic),
            identity_key_signature: b64uEncode(bundle.identityKeySignature),
            signed_prekey_public: null,
            signed_prekey_signature: null,
        };
    }

    function roster(...members: RosterEntry[]): ChatRoster {
        return { chat_id: CHAT, current_epoch: 1, member_set_hash: computeMemberSetHash(members), members };
    }

    const member = (user_id: string) => ({ user_id, role: 'member' as const, joined_at: '2026-01-01T00:00:00Z' });

    afterEach(() => localStorage.clear());

    it('gives no grant to a third member of a private chat re-labelled as a group', async () => {
        localStorage.clear();
        const cryptoApi = jasmine.createSpyObj<CryptoApiService>('CryptoApiService', [
            'getChatKeys',
            'enableEncryption',
            'getRoster',
            'publishSenderKey',
            'getOwnIdentities',
        ]);
        const messages = jasmine.createSpyObj<MessageService>('MessageService', ['sendText', 'recordOutgoing']);
        const chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['getChat']);
        TestBed.configureTestingModule({
            providers: [
                ChatStoreService,
                { provide: CryptoApiService, useValue: cryptoApi },
                { provide: MessageService, useValue: messages },
                { provide: ChatApiService, useValue: chatApi },
                {
                    provide: DirectoryService,
                    useValue: jasmine.createSpyObj('DirectoryService', [
                        'resolveMissing',
                        'rememberPrivateChatPeer',
                        'lookup',
                    ]),
                },
                { provide: SessionService, useValue: { user: () => ({ id: ME }) } },
                {
                    provide: WebSocketService,
                    useValue: {
                        messages: new Subject(),
                        reconnected: new Subject<void>(),
                        isConnected: () => true,
                        sendRead: () => undefined,
                        sendTyping: () => undefined,
                    },
                },
            ],
        });
        const store = TestBed.inject(ChatStoreService);
        const keyStore = TestBed.inject(KeyStoreService);

        // Unlocked enough to publish; the bundle sealing (Argon2id) is irrelevant to this path.
        const mine = generateIdentity(ME, DEVICE, false);
        const peer = generateIdentity(PEER, PEER_DEVICE, false);
        const intruder = generateIdentity(INTRUDER, INTRUDER_DEVICE, false);
        (keyStore as unknown as { identity: unknown }).identity = {
            userId: ME,
            deviceId: DEVICE,
            signingPrivate: mine.signingPrivate,
            signingPublic: mine.signingPublic,
            identityPrivate: mine.identityPrivate,
            kek: new Uint8Array(32),
            kdfParams: {},
        };
        (keyStore as unknown as { ownDevicesAtUnlock: Map<string, string> }).ownDevicesAtUnlock = new Map([
            [DEVICE, b64uEncode(mine.signingPublic)],
        ]);
        cryptoApi.publishSenderKey.and.returnValue(of({}));
        messages.sendText.and.callFake(async (chatId: string) => {
            await keyStore.ensureSenderChain(chatId, 1);
            return messageResponse({ _id: `sent-${Math.random()}`, sender_id: ME });
        });
        messages.recordOutgoing.and.returnValue({ ...decrypted('sent', 'ok'), senderId: ME });

        // First send: the chat as opened, {me, peer}. Pins the peer and publishes to both devices.
        cryptoApi.getRoster.and.returnValue(of(roster(entry(ME, DEVICE, mine), entry(PEER, PEER_DEVICE, peer))));
        store.chats.set([chat({ chat_type: 'private', participants: [member(ME), member(PEER)] })]);
        store.activeChatId.set(CHAT);
        await store.send('first');
        expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);

        // The server re-labels it: a group of three, with a roster (and commitment) to match.
        cryptoApi.getRoster.and.returnValue(
            of(
                roster(
                    entry(ME, DEVICE, mine),
                    entry(PEER, PEER_DEVICE, peer),
                    entry(INTRUDER, INTRUDER_DEVICE, intruder)
                )
            )
        );
        chatApi.getChat.and.returnValue(
            of(chat({ chat_type: 'group', participants: [member(ME), member(PEER), member(INTRUDER)] }))
        );
        store.chats.update((list) => list.map((c) => ({ ...c, chat_type: 'group' as const })));
        keyStore.invalidateOwnChains();
        await store.send('second');

        const grantedTo = cryptoApi.publishSenderKey.calls
            .allArgs()
            .flatMap((args) => args[2].grants.map((g) => g.recipient_device_id));
        expect(grantedTo).not.toContain(INTRUDER_DEVICE);
        expect(cryptoApi.publishSenderKey).toHaveBeenCalledTimes(1);
        expect(store.memberVerificationCode()).toBe('MEMBERSHIP_MISMATCH');

        // And the key store's own line: a group expectation cannot replace the private one.
        expect(() =>
            keyStore.expectMembers(CHAT, { kind: 'group', resolve: async () => [ME, PEER, INTRUDER] })
        ).toThrowError(MembershipMismatchError);
    });
});
