import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ed25519 } from '@noble/curves/ed25519.js';
import { of, throwError } from 'rxjs';

import { signChannelPost } from '../crypto/channel';
import { openMessage, sealMessage } from '../crypto/envelope';
import { b64uEncode, utf8 } from '../crypto/primitives';
import { SenderChain } from '../crypto/ratchet';
import { MessageAttachment, MessageResponse, PublicKey } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { CryptoApiService } from './crypto-api.service';
import { KeyStoreService } from './key-store.service';
import { MessageService } from './message.service';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const SENDER = 'b0000000-0000-4000-8000-000000000002';

function envelopeMessage(id: string, idx: number): MessageResponse {
    return {
        _id: id,
        chat_id: CHAT,
        sender_id: SENDER,
        encrypted_content: null,
        envelope: {
            v: 1,
            alg: 'x',
            epoch: 1,
            skid: 'c0000000-0000-4000-8000-000000000003',
            idx,
            n: 'nonce',
            ct: 'ct',
            sig: 'sig',
        },
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
    } as MessageResponse;
}

/** A `PublicKey` with only `user_id`/`signing_public_key` meaningful; the rest is filler. */
function publicKeyStub(userId: string, signingPublicKey: string): PublicKey {
    return {
        user_id: userId,
        device_id: 'device-1',
        identity_key_id: 'identity-1',
        version: 1,
        identity_public_key: 'unused',
        signing_public_key: signingPublicKey,
        identity_key_signature: 'unused',
        signed_prekey_public: null,
        signed_prekey_signature: null,
    };
}

function channelMessage(id: string, senderId: string, postId: string, content: string, sig: string): MessageResponse {
    const base = envelopeMessage(id, 0);
    return {
        ...base,
        envelope: null,
        sender_id: senderId,
        content_format: 'channel_signed_v1',
        channel_post: { v: 1, alg: 'ed25519-post-v1', post_id: postId, content, sig },
    };
}

describe('MessageService', () => {
    let service: MessageService;
    let keyStore: jasmine.SpyObj<KeyStoreService>;
    let chatApi: jasmine.SpyObj<ChatApiService>;
    let cryptoApi: jasmine.SpyObj<CryptoApiService>;

    beforeEach(() => {
        keyStore = jasmine.createSpyObj<KeyStoreService>(
            'KeyStoreService',
            ['getReceiverChain', 'getChainSigningKey', 'ingestDistributions', 'ensureSenderChain', 'invalidateSenderChain'],
            ['currentIdentity']
        );
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['getMessages', 'editMessage', 'sendEnvelope']);

        cryptoApi = jasmine.createSpyObj<CryptoApiService>('CryptoApiService', ['getChatKeys', 'getKeysBatch']);
        cryptoApi.getChatKeys.and.returnValue(
            of({
                crypto_mode: 'sender_keys_v1',
                history_visibility: 'joined',
                current_epoch: 1,
                my_join_epoch: 1,
                epochs: [],
                distributions: [],
            }) as never
        );

        TestBed.configureTestingModule({
            providers: [
                MessageService,
                { provide: KeyStoreService, useValue: keyStore },
                { provide: ChatApiService, useValue: chatApi },
                { provide: CryptoApiService, useValue: cryptoApi },
            ],
        });

        service = TestBed.inject(MessageService);
    });

    /**
     * The bug this exists to prevent: re-rendering a conversation used to decrypt every message
     * again, and the ratchet is single-use, so the second attempt reported `failed` — which the UI
     * presents as possible tampering.
     */
    it('opens a given message only once, reusing the plaintext', async () => {
        const chain = { messageKeyFor: jasmine.createSpy('messageKeyFor').and.throwError('consumed') };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(undefined);

        const raw = envelopeMessage('m1', 0);

        const first = await service.decrypt(CHAT, raw);
        const second = await service.decrypt(CHAT, raw);

        expect(first.status).toBe('failed');
        expect(second).toBe(first);
        // One attempt only: a second would consume another index and can never succeed.
        expect(chain.messageKeyFor).toHaveBeenCalledTimes(1);
    });

    /** `no_key` consumed nothing, so it must stay retryable once the grant arrives. */
    it('does not cache no_key, so it can resolve later', async () => {
        keyStore.getReceiverChain.and.returnValue(undefined);

        const raw = envelopeMessage('m2', 0);

        expect((await service.decrypt(CHAT, raw)).status).toBe('no_key');

        // The grant lands: the same ciphertext must now be attempted again rather than served stale.
        keyStore.getReceiverChain.and.returnValue({
            messageKeyFor: () => {
                throw new Error('still cannot open');
            },
        } as never);

        expect((await service.decrypt(CHAT, raw)).status).toBe('failed');
    });

    /**
     * The API returns newest-first, which the ratchet cannot consume: walking a chain backwards makes
     * every message after the first report a consumed index.
     */
    it('returns history oldest-first regardless of the API ordering', async () => {
        keyStore.getReceiverChain.and.returnValue(undefined);
        chatApi.getMessages.and.returnValue(of([envelopeMessage('newest', 2), envelopeMessage('oldest', 0)]));

        const { raw, messages } = await service.loadMessages(CHAT);

        expect(raw.map((m) => m._id)).toEqual(['oldest', 'newest']);
        expect(messages.map((m) => m.id)).toEqual(['oldest', 'newest']);
    });

    /**
     * The fix this guards: `loadMessages` used to call `keys/batch` once per channel post, even
     * when several posts in the same page shared a sender. It must collect every distinct sender
     * across the whole page and issue exactly one batched call for all of them.
     */
    it('fetches every distinct channel-post sender in a single keys/batch call', async () => {
        const senderA = 'd0000000-0000-4000-8000-00000000000a';
        const senderB = 'd0000000-0000-4000-8000-00000000000b';
        const privA = crypto.getRandomValues(new Uint8Array(32));
        const privB = crypto.getRandomValues(new Uint8Array(32));
        const pubA = ed25519.getPublicKey(privA);
        const pubB = ed25519.getPublicKey(privB);

        const postIdA = 'e0000000-0000-4000-8000-000000000001';
        const postIdB = 'e0000000-0000-4000-8000-000000000002';

        const sigA = signChannelPost({
            signingPrivate: privA,
            chatId: CHAT,
            senderId: senderA,
            postId: postIdA,
            content: 'hi a',
        });
        const sigB = signChannelPost({
            signingPrivate: privB,
            chatId: CHAT,
            senderId: senderB,
            postId: postIdB,
            content: 'hi b',
        });

        // Two posts from sender A (same sender should not duplicate the batch request) plus one
        // from sender B, returned newest-first the way the API actually orders them.
        const msgB = channelMessage('cb', senderB, postIdB, 'hi b', sigB);
        const msgA2 = channelMessage('ca2', senderA, postIdA, 'hi a', sigA);
        const msgA1 = channelMessage('ca1', senderA, postIdA, 'hi a', sigA);
        chatApi.getMessages.and.returnValue(of([msgB, msgA2, msgA1]));

        cryptoApi.getKeysBatch.and.returnValue(
            of([publicKeyStub(senderA, b64uEncode(pubA)), publicKeyStub(senderB, b64uEncode(pubB))])
        );

        const { messages } = await service.loadMessages(CHAT);

        expect(cryptoApi.getKeysBatch).toHaveBeenCalledTimes(1);
        const [requestedIds] = cryptoApi.getKeysBatch.calls.mostRecent().args;
        expect(new Set(requestedIds)).toEqual(new Set([senderA, senderB]));

        expect(messages.find((m) => m.id === 'ca1')?.senderVerified).toBeTrue();
        expect(messages.find((m) => m.id === 'ca2')?.senderVerified).toBeTrue();
        expect(messages.find((m) => m.id === 'cb')?.senderVerified).toBeTrue();
    });

    /**
     * The safety property reviewed by reading the code, now actually exercised: a sender absent
     * from the batch response (e.g. the server omitted a now-revoked device) must degrade to an
     * unverified post rather than throwing and breaking the whole page.
     */
    it('degrades to senderVerified: false, without throwing, when a sender is missing from the keys batch', async () => {
        const senderA = 'd0000000-0000-4000-8000-00000000000a';
        const privA = crypto.getRandomValues(new Uint8Array(32));

        const postId = 'e0000000-0000-4000-8000-000000000003';
        const sigA = signChannelPost({
            signingPrivate: privA,
            chatId: CHAT,
            senderId: senderA,
            postId,
            content: 'hi a',
        });
        const msg = channelMessage('cx', senderA, postId, 'hi a', sigA);
        chatApi.getMessages.and.returnValue(of([msg]));

        // The batch response simply does not include this sender.
        cryptoApi.getKeysBatch.and.returnValue(of([]));

        const { messages } = await service.loadMessages(CHAT);

        expect(messages.length).toBe(1);
        expect(messages[0].status).toBe('plaintext');
        expect(messages[0].senderVerified).toBeFalse();
    });

    /** Our own message is never round-tripped through the receiver ratchet; we already have the text. */
    it('records an outgoing message from known plaintext', async () => {
        const sent = envelopeMessage('mine', 0);

        const recorded = service.recordOutgoing(sent, 'hello there');

        expect(recorded.text).toBe('hello there');
        expect(recorded.status).toBe('ok');
        expect(recorded.senderVerified).toBeTrue();

        // And it is cached, so re-rendering does not try to open it.
        expect(await service.decrypt(CHAT, sent)).toBe(recorded);
        expect(keyStore.getReceiverChain).not.toHaveBeenCalled();
    });

    it('forgets one message so an edit is not served from the old plaintext', async () => {
        const sent = envelopeMessage('edited', 0);
        service.recordOutgoing(sent, 'before');

        service.forgetOne('edited');
        service.recordOutgoing(sent, 'after');

        expect((await service.decrypt(CHAT, sent)).text).toBe('after');
    });

    /** A reaction/pin change on an already-opened message must patch in place, not re-decrypt. */
    it('patches reactions and pins on an opened message without re-decrypting', async () => {
        const chain = {
            messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: new Uint8Array(32) }),
        };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(undefined);

        const raw = envelopeMessage('m-meta', 0);
        const opened = await service.decrypt(CHAT, raw);
        // This particular envelope cannot actually be opened (no real ciphertext), so it lands as
        // `failed` — irrelevant here, since the point is that a meta patch must not disturb it.
        expect(opened.status).toBe('failed');

        const patched = raw;
        patched.reactions = [{ user_id: 'u1', emoji: '👍', created_at: '2026-01-01T00:00:01Z' }];
        patched.is_pinned = true;

        const result = service.patchMeta(patched);

        expect(result).not.toBeNull();
        expect(result!.text).toBe(opened.text);
        expect(result!.status).toBe(opened.status);
        expect(result!.senderVerified).toBe(opened.senderVerified);
        expect(result!.reactions).toEqual(patched.reactions);
        expect(result!.isPinned).toBeTrue();

        // No second decrypt attempt: the ratchet was not asked for another key.
        expect(chain.messageKeyFor).toHaveBeenCalledTimes(1);
    });

    /**
     * The actual shape sealed into an envelope's plaintext is now JSON, `{text, attachmentKeys}`,
     * not bare text — and the matching attachment gets its key attached by URL after decrypt. A
     * real `sealMessage`/`openMessage` round trip, not a hand-built ciphertext, so the AAD binding
     * is exercised too.
     */
    it('parses the JSON plaintext and attaches the matching attachment key by url', async () => {
        const attachmentKey = crypto.getRandomValues(new Uint8Array(32));
        const messageKey = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
        const skid = 'c0000000-0000-4000-8000-000000000003';

        const envelope = await sealMessage({
            messageKey,
            nonce,
            signingPrivate,
            chatId: CHAT,
            epoch: 1,
            senderId: SENDER,
            senderKeyId: skid,
            chainIndex: 0,
            plaintext: utf8(
                JSON.stringify({
                    text: 'see the photo',
                    attachmentKeys: [{ url: 'files/a.png', key: b64uEncode(attachmentKey) }],
                })
            ),
        });

        const raw = envelopeMessage('m-attach', 0);
        raw.envelope = envelope;
        raw.attachments = [{ url: 'files/a.png', name: 'a.png', size: 10, content_type: 'image/png' }];

        const chain = { messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: messageKey }) };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(undefined);

        const result = await service.decrypt(CHAT, raw);

        expect(result.status).toBe('ok');
        expect(result.text).toBe('see the photo');
        expect(result.attachments[0].decryptionKey).toEqual(attachmentKey);
    });

    /** Real message history sealed before this feature existed is raw UTF-8, not JSON. */
    it('falls back to legacy plaintext when the decrypted bytes are not the JSON shape', async () => {
        const messageKey = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
        const skid = 'c0000000-0000-4000-8000-000000000003';

        const envelope = await sealMessage({
            messageKey,
            nonce,
            signingPrivate,
            chatId: CHAT,
            epoch: 1,
            senderId: SENDER,
            senderKeyId: skid,
            chainIndex: 0,
            plaintext: utf8('plain old text, not json'),
        });

        const raw = envelopeMessage('m-legacy', 0);
        raw.envelope = envelope;

        const chain = { messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: messageKey }) };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(undefined);

        const result = await service.decrypt(CHAT, raw);

        expect(result.status).toBe('ok');
        expect(result.text).toBe('plain old text, not json');
        expect(result.attachments).toEqual([]);
    });

    /**
     * The regression this guards: a meta update landing while the first `decrypt()` for that
     * message is still in flight used to be silently dropped, because `patchMeta` found no `opened`
     * cache entry yet and gave up. The fix records it into a side-map that `decrypt()` consults once
     * it actually resolves, so the cached result reflects the patch rather than the stale value
     * baked into the `MessageResponse` that was originally handed to `decrypt()`.
     */
    it('applies a meta patch that arrives before the first decrypt resolves', async () => {
        keyStore.getChainSigningKey.and.returnValue(undefined);

        // `messageKeyFor` itself is called synchronously in `decryptOnce` (never awaited) — the
        // genuine in-flight window is inside `openMessage`'s real WebCrypto calls, which this test
        // relies on rather than faking, so it exercises the actual await boundary.
        const chain = {
            messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: new Uint8Array(32) }),
        };
        keyStore.getReceiverChain.and.returnValue(chain as never);

        const raw = envelopeMessage('m-race', 0);
        // Stale reactions/pin baked into the object handed to decrypt() — this is what would be
        // cached if the race were lost.
        raw.reactions = [];
        raw.is_pinned = false;

        const decryptPromise = service.decrypt(CHAT, raw);

        // decrypt() has started synchronously and is now paused inside `openMessage`'s real
        // WebCrypto `await` — nothing has been cached into `opened` for this id yet, so this is
        // exactly the window the bug lost.
        const fresh = { ...raw, reactions: [{ user_id: 'u2', emoji: '❤️', created_at: '2026-01-01T00:00:02Z' }] };
        fresh.is_pinned = true;
        const patchResult = service.patchMeta(fresh);
        expect(patchResult).toBeNull(); // nothing cached yet — this is the drop the old code hit

        const result = await decryptPromise;

        expect(result.reactions).toEqual(fresh.reactions);
        expect(result.isPinned).toBeTrue();

        // And the cache now reflects the patched value too, not the stale one.
        const second = await service.decrypt(CHAT, raw);
        expect(second.reactions).toEqual(fresh.reactions);
        expect(second.isPinned).toBeTrue();
    });

    describe('sendText idempotency key', () => {
        const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

        beforeEach(() => {
            keyStore.ensureSenderChain.and.callFake(() =>
                Promise.resolve({
                    senderKeyId: 'c0000000-0000-4000-8000-000000000003',
                    chain: new SenderChain(crypto.getRandomValues(new Uint8Array(32))),
                    chainSigningPrivate: crypto.getRandomValues(new Uint8Array(32)),
                } as never)
            );
            Object.defineProperty(keyStore, 'currentIdentity', {
                value: { userId: SENDER, deviceId: 'device-1' },
            });
        });

        const staleError = () =>
            new HttpErrorResponse({
                status: 409,
                error: { error_code: 'EPOCH_STALE', details: { current_epoch: 2 } },
            });

        it('sends a fresh UUIDv4 per logical message', async () => {
            chatApi.sendEnvelope.and.returnValue(of(envelopeMessage('m1', 0)));

            await service.sendText(CHAT, 'one');
            await service.sendText(CHAT, 'two');

            const first = chatApi.sendEnvelope.calls.argsFor(0)[5];
            const second = chatApi.sendEnvelope.calls.argsFor(1)[5];
            expect(first).toMatch(UUID_V4);
            expect(second).toMatch(UUID_V4);
            expect(first).not.toBe(second);
        });

        it('reuses the same id when EPOCH_STALE forces a re-encrypt and retry', async () => {
            chatApi.sendEnvelope.and.returnValues(throwError(() => staleError()), of(envelopeMessage('m1', 0)));

            await service.sendText(CHAT, 'hello');

            expect(chatApi.sendEnvelope).toHaveBeenCalledTimes(2);
            const [first, second] = [chatApi.sendEnvelope.calls.argsFor(0), chatApi.sendEnvelope.calls.argsFor(1)];
            expect(first[5]).toMatch(UUID_V4);
            expect(second[5]).toBe(first[5]);
            // The retry is a genuine re-seal, not the old ciphertext resent.
            expect(second[1]).not.toEqual(first[1]);
        });

        it('uses a caller-supplied id, for a manual retry', async () => {
            chatApi.sendEnvelope.and.returnValue(of(envelopeMessage('m1', 0)));

            await service.sendText(CHAT, 'hello', undefined, undefined, undefined, 'kept-id');

            expect(chatApi.sendEnvelope.calls.mostRecent().args[5]).toBe('kept-id');
        });

        it('resolves with the stored message whether the server replied 200 or 201', async () => {
            // HttpClient treats every 2xx alike and the unwrapped body is identical, so the replay
            // (200) must come out exactly like the first store (201).
            const stored = envelopeMessage('m1', 0);
            chatApi.sendEnvelope.and.returnValue(of(stored));

            const created = await service.sendText(CHAT, 'hello', undefined, undefined, undefined, 'same-id');
            const replayed = await service.sendText(CHAT, 'hello', undefined, undefined, undefined, 'same-id');

            expect(created._id).toBe('m1');
            expect(replayed._id).toBe('m1');
        });
    });

    describe('editText', () => {
        /**
         * The replacement list may mix an attachment that survived the edit (carrying the key it
         * was already decrypted with) and one freshly added during this edit session (carrying the
         * key it was just encrypted under). Both keys belong in the fresh plaintext's
         * `attachmentKeys`, and neither may reach `ChatApiService.editMessage` on the wire.
         */
        it('builds {text, attachmentKeys} from a mix of kept and newly added attachments, and sends the stripped list', async () => {
            const chainKey = crypto.getRandomValues(new Uint8Array(32));
            const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
            const senderKeyId = 'c0000000-0000-4000-8000-000000000003';

            keyStore.ensureSenderChain.and.resolveTo({
                senderKeyId,
                chain: new SenderChain(chainKey),
                chainSigningPrivate: signingPrivate,
            } as never);
            Object.defineProperty(keyStore, 'currentIdentity', {
                value: { userId: SENDER, deviceId: 'device-1' },
            });

            const keptKey = crypto.getRandomValues(new Uint8Array(32));
            const newKey = crypto.getRandomValues(new Uint8Array(32));
            const kept: MessageAttachment = {
                url: 'files/kept.png',
                name: 'kept.png',
                size: 10,
                content_type: 'image/png',
                decryptionKey: keptKey,
            };
            const added: MessageAttachment = {
                url: 'files/added.png',
                name: 'added.png',
                size: 20,
                content_type: 'image/png',
                decryptionKey: newKey,
            };

            const updated = envelopeMessage('m-edit', 1);
            updated.attachments = [kept, added].map((file) => {
                const copy = { ...file };
                delete copy.decryptionKey;
                return copy;
            });
            chatApi.editMessage.and.returnValue(of(updated));

            const result = await service.editText(CHAT, 'm-edit', 'updated text', [kept, added]);

            expect(chatApi.editMessage).toHaveBeenCalledTimes(1);
            const [, envelope, wireAttachments] = chatApi.editMessage.calls.mostRecent().args;
            expect(wireAttachments).toEqual([
                { url: kept.url, name: kept.name, size: kept.size, content_type: kept.content_type },
                { url: added.url, name: added.name, size: added.size, content_type: added.content_type },
            ]);

            // The keys travelled inside the sealed plaintext, not on the wire attachment list.
            const chain = new SenderChain(chainKey);
            const { key } = chain.nextMessageKey();
            const plaintext = await openMessage({
                messageKey: key,
                envelope,
                chatId: CHAT,
                senderId: SENDER,
                signingPublic: undefined,
            });
            const parsed = JSON.parse(new TextDecoder().decode(plaintext));
            expect(parsed.text).toBe('updated text');
            expect(parsed.attachmentKeys).toEqual(
                jasmine.arrayContaining([
                    { url: kept.url, key: b64uEncode(keptKey) },
                    { url: added.url, key: b64uEncode(newKey) },
                ])
            );

            expect(result.text).toBe('updated text');
            expect(result.attachments.find((f) => f.url === kept.url)?.decryptionKey).toEqual(keptKey);
            expect(result.attachments.find((f) => f.url === added.url)?.decryptionKey).toEqual(newKey);
        });

        /**
         * An attachment with no `decryptionKey` (stale/corrupted sender, or added by some other
         * client that never sealed a key for it) must never be carried into an edit's fresh
         * plaintext — `buildPlaintext` would silently drop it from `attachmentKeys` while
         * `stripDecryptionKeys` keeps it in the wire-bound attachment list, permanently orphaning
         * the file. `editText` must refuse outright, before the server is ever contacted.
         */
        it('throws and never calls editMessage when a kept attachment has no decryption key', async () => {
            Object.defineProperty(keyStore, 'currentIdentity', {
                value: { userId: SENDER, deviceId: 'device-1' },
            });

            const unkeyed: MessageAttachment = {
                url: 'files/unkeyed.png',
                name: 'unkeyed.png',
                size: 10,
                content_type: 'image/png',
                // no decryptionKey
            };

            await expectAsync(service.editText(CHAT, 'm-edit', 'updated text', [unkeyed])).toBeRejectedWithError(
                /unkeyed\.png.*no decryption key/
            );

            expect(chatApi.editMessage).not.toHaveBeenCalled();
            expect(keyStore.ensureSenderChain).not.toHaveBeenCalled();
        });

        /**
         * Stickers are deliberately unkeyed — public, unencrypted images from the sticker-packs
         * bucket, never sealed (see `onStickerPicked()` in `composer.component.ts`). A sticker
         * attachment with no `decryptionKey` must not trip the same guard that catches a
         * genuinely-orphaned keyed attachment above: `assertAttachmentsKeyed` must exempt
         * `kind: 'sticker'`, exactly as `buildPlaintext` already excludes it from
         * `attachmentKeys`. Regression test for editing any message that carries a sticker.
         */
        it('does not throw when the only attachment is an unkeyed sticker', async () => {
            const chainKey = crypto.getRandomValues(new Uint8Array(32));
            const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
            const senderKeyId = 'c0000000-0000-4000-8000-000000000004';

            keyStore.ensureSenderChain.and.resolveTo({
                senderKeyId,
                chain: new SenderChain(chainKey),
                chainSigningPrivate: signingPrivate,
            } as never);
            Object.defineProperty(keyStore, 'currentIdentity', {
                value: { userId: SENDER, deviceId: 'device-1' },
            });

            const sticker: MessageAttachment = {
                url: 'stickers/pack/wave.webp',
                name: 'wave.webp',
                size: 5,
                content_type: 'image/webp',
                kind: 'sticker',
                // no decryptionKey — stickers are never sealed.
            };

            const updated = envelopeMessage('m-edit', 1);
            updated.attachments = [{ ...sticker }];
            chatApi.editMessage.and.returnValue(of(updated));

            const result = await service.editText(CHAT, 'm-edit', 'updated text', [sticker]);

            expect(chatApi.editMessage).toHaveBeenCalledTimes(1);
            const [, envelope, wireAttachments] = chatApi.editMessage.calls.mostRecent().args;
            expect(wireAttachments).toEqual([
                {
                    url: sticker.url,
                    name: sticker.name,
                    size: sticker.size,
                    content_type: sticker.content_type,
                    kind: sticker.kind,
                },
            ]);

            // The sticker is excluded from attachmentKeys, same as buildPlaintext does for sends.
            const chain = new SenderChain(chainKey);
            const { key } = chain.nextMessageKey();
            const plaintext = await openMessage({
                messageKey: key,
                envelope,
                chatId: CHAT,
                senderId: SENDER,
                signingPublic: undefined,
            });
            const parsed = JSON.parse(new TextDecoder().decode(plaintext));
            expect(parsed.text).toBe('updated text');
            expect(parsed.attachmentKeys).toEqual([]);

            expect(result.text).toBe('updated text');
        });
    });
});
