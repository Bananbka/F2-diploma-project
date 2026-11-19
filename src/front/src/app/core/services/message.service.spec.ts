import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ed25519 } from '@noble/curves/ed25519.js';
import { of, throwError } from 'rxjs';

import { signChannelPost } from '../crypto/channel';
import { openMessage, sealMessage } from '../crypto/envelope';
import { b64uEncode, utf8 } from '../crypto/primitives';
import { ReceiverChain, SenderChain } from '../crypto/ratchet';
import { MessageAttachment, MessageResponse, PublicKey } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { CryptoApiService } from './crypto-api.service';
import { RetryLimitExceededError } from './crypto-errors';
import { KeyStoreService } from './key-store.service';
import { DecryptedMessage, MessageService } from './message.service';

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

const SKID = 'c0000000-0000-4000-8000-000000000003';
/** What a caller of `recordOutgoing` knows for itself; the fixtures' sender doubles as "us" here. */
const MINE = { chatId: CHAT, senderId: SENDER };

/**
 * A message whose envelope carries a VALID signature over a ciphertext sealed under `sealKey`.
 * Lets a test get past the pre-ratchet signature check and exercise what happens after the chain
 * was touched (e.g. a GCM failure because the chain hands back a different key).
 */
async function signedMessage(
    id: string,
    idx: number,
    signingPrivate: Uint8Array,
    sealKey: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
    text = 'hello',
    nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12))
): Promise<MessageResponse> {
    const raw = envelopeMessage(id, idx);
    raw.envelope = await sealMessage({
        messageKey: sealKey,
        nonce,
        signingPrivate,
        chatId: CHAT,
        epoch: 1,
        senderId: SENDER,
        senderKeyId: SKID,
        chainIndex: idx,
        plaintext: utf8(text),
    });
    return raw;
}

describe('MessageService', () => {
    let service: MessageService;
    let keyStore: jasmine.SpyObj<KeyStoreService>;
    let chatApi: jasmine.SpyObj<ChatApiService>;
    let cryptoApi: jasmine.SpyObj<CryptoApiService>;

    beforeEach(() => {
        keyStore = jasmine.createSpyObj<KeyStoreService>(
            'KeyStoreService',
            [
                'getReceiverChain',
                'getChainSigningKey',
                'getChainOwner',
                'ingestDistributions',
                'ensureSenderChain',
                'invalidateSenderChain',
            ],
            ['currentIdentity']
        );
        // By default the chain belongs to the message's claimed sender, as it does in real use.
        keyStore.getChainOwner.and.returnValue(SENDER);
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', [
            'getMessages',
            'editMessage',
            'sendEnvelope',
        ]);

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

    it('refuses a message whose claimed sender does not own the chain it was sealed on', async () => {
        const chain = { messageKeyFor: jasmine.createSpy('messageKeyFor') };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(undefined);
        // The chain was ingested as belonging to someone other than the sender this message names.
        keyStore.getChainOwner.and.returnValue('d0000000-0000-4000-8000-0000000000ff');

        const result = await service.decrypt(CHAT, envelopeMessage('forged', 0));

        expect(result.status).toBe('failed');
        expect(result.text).toBeNull();
        expect(result.senderVerified).toBeFalse();
        // Rejected before the ratchet moved, so the real owner's index is not burned.
        expect(chain.messageKeyFor).not.toHaveBeenCalled();
    });

    it('refuses a message on a chain whose owner is unknown', async () => {
        keyStore.getReceiverChain.and.returnValue({ messageKeyFor: jasmine.createSpy() } as never);
        keyStore.getChainOwner.and.returnValue(undefined);

        const result = await service.decrypt(CHAT, envelopeMessage('orphan', 0));

        expect(result.status).toBe('failed');
    });

    /**
     * The bug this exists to prevent: re-rendering a conversation used to decrypt every message
     * again, and the ratchet is single-use, so the second attempt reported `failed` — which the UI
     * presents as possible tampering.
     */
    it('opens a given message only once, reusing the plaintext', async () => {
        const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
        const chain = { messageKeyFor: jasmine.createSpy('messageKeyFor').and.throwError('tag mismatch') };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));

        const raw = await signedMessage('m1', 0, signingPrivate);

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

        const recorded = service.recordOutgoing(MINE, sent, 'hello there');

        expect(recorded.text).toBe('hello there');
        expect(recorded.status).toBe('ok');
        expect(recorded.senderVerified).toBeTrue();

        // And it is cached, so re-rendering does not try to open it.
        expect(await service.decrypt(CHAT, sent)).toBe(recorded);
        expect(keyStore.getReceiverChain).not.toHaveBeenCalled();
    });

    /**
     * The response to our own send is the server's word. A send in one chat answered with the id,
     * chat and sender of a message in another must not put our text there under that sender's name.
     */
    describe('recordOutgoing against a forged send response', () => {
        const OTHER_CHAT = 'a0000000-0000-4000-8000-0000000000bb';
        const ME = 'd0000000-0000-4000-8000-0000000000dd';
        const ID = 'peer-message-in-the-first-chat';
        let theirs: MessageResponse;
        let opened: DecryptedMessage;

        beforeEach(async () => {
            const chainKey = crypto.getRandomValues(new Uint8Array(32));
            const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
            keyStore.getReceiverChain.and.returnValue(new ReceiverChain(chainKey.slice()) as never);
            keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));
            const { key, nonce, index } = new SenderChain(chainKey.slice()).nextMessageKey();
            theirs = await signedMessage(ID, index, signingPrivate, key, 'what the peer said', nonce);
            opened = await service.decrypt(CHAT, theirs);
            expect(opened.status).toBe('ok');
        });

        it('takes chat and sender from the caller, not from the response', () => {
            const response = { ...envelopeMessage('fresh-id', 0), chat_id: CHAT, sender_id: SENDER };

            const recorded = service.recordOutgoing({ chatId: OTHER_CHAT, senderId: ME }, response, 'my text');

            expect(recorded.chatId).toBe(OTHER_CHAT);
            expect(recorded.senderId).toBe(ME);
        });

        it('does not overwrite a message of another chat when the response names its id', async () => {
            // Sent in OTHER_CHAT; the response claims the first chat's id, chat and sender.
            const response = { ...envelopeMessage(ID, 5), chat_id: CHAT, sender_id: SENDER };

            const recorded = service.recordOutgoing({ chatId: OTHER_CHAT, senderId: ME }, response, 'my text');

            expect(recorded.senderId).withContext('never the sender the server named').toBe(ME);
            const reopened = await service.decrypt(CHAT, theirs);
            expect(reopened).toBe(opened);
            expect(reopened.text).toBe('what the peer said');
            expect(reopened.senderId).toBe(SENDER);
        });

        it("does not overwrite someone else's message in the same chat either", async () => {
            const response = { ...envelopeMessage(ID, 5), sender_id: SENDER };

            service.recordOutgoing({ chatId: CHAT, senderId: ME }, response, 'my text');

            expect(await service.decrypt(CHAT, theirs)).toBe(opened);
        });

        it('still replaces our own entry in the same chat (an edit, or the socket echo)', async () => {
            const mine = envelopeMessage('mine', 0);
            service.recordOutgoing({ chatId: CHAT, senderId: ME }, mine, 'before');

            const after = service.recordOutgoing({ chatId: CHAT, senderId: ME }, mine, 'after');

            expect(await service.decrypt(CHAT, mine)).toBe(after);
        });
    });

    it('forgets one message so an edit is not served from the old plaintext', async () => {
        const sent = envelopeMessage('edited', 0);
        service.recordOutgoing(MINE, sent, 'before');

        service.forgetOne('edited');
        service.recordOutgoing(MINE, sent, 'after');

        expect((await service.decrypt(CHAT, sent)).text).toBe('after');
    });

    /** A reaction/pin change on an already-opened message must patch in place, not re-decrypt. */
    it('patches reactions and pins on an opened message without re-decrypting', async () => {
        const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
        const chain = {
            messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: new Uint8Array(32) }),
        };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));

        const raw = await signedMessage('m-meta', 0, signingPrivate);
        const opened = await service.decrypt(CHAT, raw);
        // Signed correctly but sealed under a key the chain does not hand back, so it lands as
        // `failed` after the ratchet was touched — irrelevant here, since the point is that a meta
        // patch must not disturb it.
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

        const chain = { messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: messageKey, nonce }) };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));

        const result = await service.decrypt(CHAT, raw);

        expect(result.status).toBe('ok');
        expect(result.text).toBe('see the photo');
        expect(result.attachments[0].decryptionKey).toEqual(attachmentKey);
    });

    describe('concurrent and out-of-order decrypts', () => {
        let sender: SenderChain;
        let receiver: ReceiverChain;
        let signingPrivate: Uint8Array;

        beforeEach(() => {
            const chainKey = crypto.getRandomValues(new Uint8Array(32));
            sender = new SenderChain(chainKey.slice());
            receiver = new ReceiverChain(chainKey.slice());
            signingPrivate = crypto.getRandomValues(new Uint8Array(32));
            keyStore.getReceiverChain.and.returnValue(receiver as never);
            keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));
        });

        /** Seal the next message on the sender chain; its index is whatever the chain is at. */
        async function seal(id: string, text: string): Promise<MessageResponse> {
            const { key, nonce, index } = sender.nextMessageKey();
            const raw = envelopeMessage(id, index);
            raw.envelope = await sealMessage({
                messageKey: key,
                nonce,
                signingPrivate,
                chatId: CHAT,
                epoch: 1,
                senderId: SENDER,
                senderKeyId: SKID,
                chainIndex: index,
                plaintext: utf8(text),
            });
            return raw;
        }

        it('shares one run between concurrent decrypts of the same message', async () => {
            const raw = await seal('dup', 'hello');
            const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();

            const [a, b] = await Promise.all([service.decrypt(CHAT, raw), service.decrypt(CHAT, raw)]);

            expect(spy).toHaveBeenCalledTimes(1);
            expect(a.status).toBe('ok');
            expect(b).toBe(a);
        });

        it('does not let a consumed-index failure stand as the verdict for the message', async () => {
            const raw = await seal('consumed', 'hello');
            receiver.messageKeyFor(raw.envelope!.idx); // consumed behind our back

            const first = await service.decrypt(CHAT, raw);
            expect(first.status).toBe('failed');

            // Not remembered as the message's verdict: a second look is a fresh attempt.
            const again = await service.decrypt(CHAT, raw);
            expect(again).not.toBe(first);
        });

        it('never replaces a cached plaintext with one from a lower envelope index', async () => {
            const old = await seal('edit', 'v-old'); // idx 0
            const newer = await seal('edit', 'v-new'); // idx 1, same message id

            const results = await Promise.all([service.decrypt(CHAT, newer), service.decrypt(CHAT, old)]);

            expect(results[0].text).toBe('v-new');
            expect((await service.decrypt(CHAT, old)).text).toBe('v-new');
        });
    });

    /**
     * F-M1: the receiver ratchet is destructive, so nothing may reach `messageKeyFor` until the
     * envelope is known to be well-formed and signed by the chain's key. Otherwise a forged
     * envelope (e.g. injected by the server under a real sender's skid at a future index) burns the
     * key the genuine message at that index needs, and that message reports `failed` forever.
     */
    describe('checks before the ratchet is touched', () => {
        let sender: SenderChain;
        let receiver: ReceiverChain;
        let signingPrivate: Uint8Array;

        beforeEach(() => {
            const chainKey = crypto.getRandomValues(new Uint8Array(32));
            sender = new SenderChain(chainKey.slice());
            receiver = new ReceiverChain(chainKey.slice());
            signingPrivate = crypto.getRandomValues(new Uint8Array(32));
            keyStore.getReceiverChain.and.returnValue(receiver as never);
            keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));
        });

        async function sealNext(id: string, text: string): Promise<MessageResponse> {
            const { key, nonce, index } = sender.nextMessageKey();
            return signedMessage(id, index, signingPrivate, key, text, nonce);
        }

        /** Same skid, a future index, garbage ciphertext and signature. */
        function forged(id: string, idx: number): MessageResponse {
            const raw = envelopeMessage(id, idx);
            raw.envelope = {
                ...raw.envelope!,
                alg: 'A256GCM-SK1',
                n: b64uEncode(new Uint8Array(12)),
                ct: b64uEncode(crypto.getRandomValues(new Uint8Array(48))),
                sig: b64uEncode(crypto.getRandomValues(new Uint8Array(64))),
            };
            return raw;
        }

        it('rejects a bad signature at a future index without advancing the chain', async () => {
            const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();

            const result = await service.decrypt(CHAT, forged('forged-3', 3));

            expect(result.status).toBe('failed');
            expect(result.senderVerified).toBeFalse();
            expect(spy).not.toHaveBeenCalled();
            expect(receiver.index).toBe(0);
            expect(receiver.skipped.size).toBe(0);
        });

        it('still opens the genuine message at that index after a forged one was refused', async () => {
            await service.decrypt(CHAT, forged('forged-3', 3));

            const genuine: MessageResponse[] = [];
            for (let i = 0; i <= 3; i += 1) {
                genuine.push(await sealNext(`m${i}`, `text ${i}`));
            }

            // Out of order on purpose: index 3 first, the index the forgery targeted.
            const third = await service.decrypt(CHAT, genuine[3]);
            expect(third.status).toBe('ok');
            expect(third.text).toBe('text 3');
            expect(third.senderVerified).toBeTrue();

            for (const raw of genuine.slice(0, 3)) {
                expect((await service.decrypt(CHAT, raw)).status).toBe('ok');
            }
        });

        it('does not cache a signature refusal as the verdict for that message id', async () => {
            const refused = await service.decrypt(CHAT, forged('same-id', 0));
            expect(refused.status).toBe('failed');

            const genuine = await sealNext('same-id', 'the real one');
            const opened = await service.decrypt(CHAT, genuine);

            expect(opened.status).toBe('ok');
            expect(opened.text).toBe('the real one');
        });

        /**
         * M3: `n` is not covered by the signature, so it is the one envelope field the server can
         * rewrite on a genuine message. It used to be the GCM IV: the signature passed, the key was
         * consumed, the tag failed, and the message was `failed` for good.
         */
        it('opens a genuine message whose nonce field was rewritten in transit', async () => {
            const genuine = await sealNext('n-altered', 'still readable');
            genuine.envelope = { ...genuine.envelope!, n: b64uEncode(new Uint8Array(12)) };

            const opened = await service.decrypt(CHAT, genuine);

            expect(opened.status).toBe('ok');
            expect(opened.text).toBe('still readable');
            expect(opened.senderVerified).toBeTrue();
        });

        /**
         * M4: a `message_edited` event is unauthenticated. The edit is opened first and the cached
         * plaintext is given up only if that works, because the ciphertext behind it is spent.
         */
        describe('decryptEdit', () => {
            const ID = 'edited-message';

            /** The next message on the chain, presented under the id being edited. */
            async function version(text: string): Promise<MessageResponse> {
                return sealNext(ID, text);
            }

            it('replaces an opened message with a genuine edit at a higher index', async () => {
                await service.decrypt(CHAT, await version('v1'));
                const edit = await version('v2');

                const outcome = await service.decryptEdit(CHAT, edit);

                expect(outcome.replaced).toBeTrue();
                expect(outcome.message.text).toBe('v2');
                expect((await service.decrypt(CHAT, edit)).text)
                    .withContext('cached as the new version')
                    .toBe('v2');
            });

            it('keeps the opened message when the "edit" does not authenticate', async () => {
                const original = await version('v1');
                const opened = await service.decrypt(CHAT, original);
                const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();

                const outcome = await service.decryptEdit(CHAT, forged(ID, 7));

                expect(outcome.replaced).toBeFalse();
                expect(outcome.missingKey).toBeFalse();
                expect(outcome.message).toBe(opened);
                expect(spy).withContext('the ratchet was not touched').not.toHaveBeenCalled();
                expect((await service.decrypt(CHAT, original)).text).toBe('v1');
            });

            it('keeps the opened message when the edit authenticates but will not open', async () => {
                const original = await version('v1');
                const opened = await service.decrypt(CHAT, original);
                // Signed by the chain key, sealed under a key the chain never derives.
                const unopenable = await signedMessage(ID, 3, signingPrivate);

                const outcome = await service.decryptEdit(CHAT, unopenable);

                expect(outcome.replaced).toBeFalse();
                expect(outcome.missingKey).toBeFalse();
                expect(outcome.message).toBe(opened);
                expect(await service.decrypt(CHAT, original))
                    .withContext('still cached')
                    .toBe(opened);
            });

            it('refuses a same-chain "edit" at an index not above the opened one, without spending its key', async () => {
                const earlier = await sealNext('some-other-message', 'earlier, never delivered');
                const opened = await service.decrypt(CHAT, await version('v1'));
                expect(receiver.skipped.has(earlier.envelope!.idx)).withContext('retained while skipping').toBeTrue();
                const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();

                // A genuine envelope of the same sender, relabelled as an edit of the opened message.
                const outcome = await service.decryptEdit(CHAT, { ...earlier, _id: ID });

                expect(outcome.replaced).toBeFalse();
                expect(outcome.message).toBe(opened);
                expect(spy).not.toHaveBeenCalled();
                expect(receiver.skipped.has(earlier.envelope!.idx)).toBeTrue();
                // The message that envelope really is still opens under its own id.
                expect((await service.decrypt(CHAT, earlier)).text).toBe('earlier, never delivered');
            });

            it('refuses an "edit" that names a different sender', async () => {
                const opened = await service.decrypt(CHAT, await version('v1'));
                const edit = { ...(await version('v2')), sender_id: 'f0000000-0000-4000-8000-00000000000f' };
                const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();

                const outcome = await service.decryptEdit(CHAT, edit);

                expect(outcome.replaced).toBeFalse();
                expect(outcome.message).toBe(opened);
                expect(spy).not.toHaveBeenCalled();
            });

            it('refuses an "edit" that would swap an opened message for unencrypted content', async () => {
                const opened = await service.decrypt(CHAT, await version('v1'));
                const downgrade = {
                    ...envelopeMessage(ID, 9),
                    envelope: null,
                    content_format: 'legacy_plaintext',
                    encrypted_content: 'the server wrote this',
                } as unknown as MessageResponse;

                const outcome = await service.decryptEdit(CHAT, downgrade);

                expect(outcome.replaced).toBeFalse();
                expect(outcome.message).toBe(opened);
            });

            it('keeps the old content and reports a missing key when the edit is on a chain we do not hold', async () => {
                const opened = await service.decrypt(CHAT, await version('v1'));
                const elsewhere = await version('v2');
                const otherSkid = 'c0000000-0000-4000-8000-0000000000ee';
                elsewhere.envelope = { ...elsewhere.envelope!, skid: otherSkid };
                keyStore.getReceiverChain.and.callFake(((_chat: string, _epoch: number, skid: string) =>
                    skid === otherSkid ? undefined : receiver) as never);

                const outcome = await service.decryptEdit(CHAT, elsewhere);

                expect(outcome.replaced).toBeFalse();
                expect(outcome.missingKey).toBeTrue();
                expect(outcome.message).toBe(opened);
            });

            it('refuses an "edit" from an earlier epoch', async () => {
                const first = await version('v1');
                first.envelope = { ...first.envelope!, epoch: 2 };
                // Opened through the cache directly: only its recorded position matters here.
                service.recordOutgoing(MINE, first, 'v1');
                const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();

                const outcome = await service.decryptEdit(CHAT, await version('rolled back'));

                expect(outcome.replaced).toBeFalse();
                expect(outcome.message.text).toBe('v1');
                expect(spy).not.toHaveBeenCalled();
            });

            it('lets an edit replace a placeholder, which protects nothing', async () => {
                // Cached as `failed`: authenticated, but sealed under a key the chain does not derive.
                const broken = await signedMessage(ID, sender.nextMessageKey().index, signingPrivate);
                expect((await service.decrypt(CHAT, broken)).status).toBe('failed');

                const outcome = await service.decryptEdit(CHAT, await version('readable now'));

                expect(outcome.replaced).toBeTrue();
                expect(outcome.message.status).toBe('ok');
                expect(outcome.message.text).toBe('readable now');
            });

            it('opens an edit of a message this session never opened', async () => {
                const outcome = await service.decryptEdit(CHAT, await version('first sight'));

                expect(outcome.replaced).toBeTrue();
                expect(outcome.message.text).toBe('first sight');
            });
        });

        /**
         * F2: the plaintext cache is keyed by message id, and the id is the server's word. The
         * envelope binds the chat (AAD) but not the id, so a genuine, unopened envelope of the same
         * sender from the *open* chat, presented as an edit of an id opened in *another* chat, used
         * to authenticate and replace that other chat's message.
         */
        describe('a message id presented in another chat', () => {
            const OTHER_CHAT = 'a0000000-0000-4000-8000-0000000000bb';
            const ID = 'opened-in-the-first-chat';
            let otherSender: SenderChain;
            let otherReceiver: ReceiverChain;

            beforeEach(() => {
                const chainKey = crypto.getRandomValues(new Uint8Array(32));
                otherSender = new SenderChain(chainKey.slice());
                otherReceiver = new ReceiverChain(chainKey.slice());
                keyStore.getReceiverChain.and.callFake(((chatId: string) =>
                    chatId === OTHER_CHAT ? otherReceiver : receiver) as never);
            });

            /** A genuine message of the same sender in the other chat, on that chat's own chain. */
            async function sealInOtherChat(
                id: string,
                text: string,
                claimedChat = OTHER_CHAT
            ): Promise<MessageResponse> {
                const { key, nonce, index } = otherSender.nextMessageKey();
                const raw = envelopeMessage(id, index);
                raw.chat_id = claimedChat;
                raw.envelope = await sealMessage({
                    messageKey: key,
                    nonce,
                    signingPrivate,
                    chatId: OTHER_CHAT,
                    epoch: 1,
                    senderId: SENDER,
                    senderKeyId: SKID,
                    chainIndex: index,
                    plaintext: utf8(text),
                });
                return raw;
            }

            for (const claimedChat of [OTHER_CHAT, CHAT]) {
                const label = claimedChat === CHAT ? 'the first chat' : 'the open chat';

                it(`does not let an "edit" in the open chat replace it (chat_id says ${label})`, async () => {
                    const original = await sealNext(ID, 'said in the first chat');
                    const opened = await service.decrypt(CHAT, original);
                    const spy = spyOn(otherReceiver, 'messageKeyFor').and.callThrough();

                    const edit = await sealInOtherChat(ID, 'said in the other chat', claimedChat);
                    const outcome = await service.decryptEdit(OTHER_CHAT, edit);

                    expect(outcome.replaced).toBeFalse();
                    expect(outcome.missingKey).toBeFalse();
                    expect(outcome.message).toBe(opened);
                    expect(spy).withContext('no key of the open chat was spent').not.toHaveBeenCalled();
                    // Reopening the first chat still shows what was said there.
                    const reopened = await service.decrypt(CHAT, original);
                    expect(reopened).toBe(opened);
                    expect(reopened.text).toBe('said in the first chat');
                    // And the envelope still opens as the message it really is, under its own id.
                    const real = await service.decrypt(OTHER_CHAT, { ...edit, _id: 'its-own-id' });
                    expect(real.text).toBe('said in the other chat');
                });
            }

            it('does not let it replace a placeholder of the other chat either', async () => {
                // Cached as `failed` in the first chat: authenticated, but it will not open.
                const broken = await signedMessage(ID, sender.nextMessageKey().index, signingPrivate);
                const placeholder = await service.decrypt(CHAT, broken);
                expect(placeholder.status).toBe('failed');

                const outcome = await service.decryptEdit(OTHER_CHAT, await sealInOtherChat(ID, 'from elsewhere'));

                expect(outcome.replaced).toBeFalse();
                expect(await service.decrypt(CHAT, broken)).toBe(placeholder);
            });

            it('treats an entry cached for another chat as a miss, and does not overwrite it', async () => {
                const original = await sealNext(ID, 'said in the first chat');
                const opened = await service.decrypt(CHAT, original);

                const elsewhere = await service.decrypt(
                    OTHER_CHAT,
                    await sealInOtherChat(ID, 'said in the other chat')
                );

                // Not answered from the first chat's entry...
                expect(elsewhere).not.toBe(opened);
                expect(elsewhere.chatId).toBe(OTHER_CHAT);
                expect(elsewhere.text).toBe('said in the other chat');
                // ...and the first chat's entry is still the one cached under that id.
                expect(await service.decrypt(CHAT, original)).toBe(opened);
            });

            it('files a cached entry under the chat it was opened for, whatever chat_id the server put on it', async () => {
                const relabelled = { ...(await sealNext(ID, 'said in the first chat')), chat_id: OTHER_CHAT };

                const opened = await service.decrypt(CHAT, relabelled);

                expect(opened.status).toBe('ok');
                expect(opened.chatId).toBe(CHAT);
                expect(await service.decrypt(CHAT, relabelled)).toBe(opened);
            });
        });

        for (const idx of [1.5, -1, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY]) {
            it(`refuses chain index ${idx} without touching the chain`, async () => {
                const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();
                const raw = envelopeMessage(`bad-idx-${idx}`, 0);
                raw.envelope = { ...raw.envelope!, idx };

                const result = await service.decrypt(CHAT, raw);

                expect(result.status).toBe('failed');
                expect(spy).not.toHaveBeenCalled();
                expect(receiver.index).toBe(0);
                expect(receiver.skipped.size).toBe(0);
            });
        }

        it('refuses to open anything when no signing key is known for the chain', async () => {
            keyStore.getChainSigningKey.and.returnValue(undefined);
            const spy = spyOn(receiver, 'messageKeyFor').and.callThrough();
            const genuine = await sealNext('m0', 'hi');

            const result = await service.decrypt(CHAT, genuine);

            expect(result.status).toBe('failed');
            expect(spy).not.toHaveBeenCalled();
            expect(receiver.index).toBe(0);

            // Nothing was consumed, so once the key is known the message still opens.
            keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));
            expect((await service.decrypt(CHAT, genuine)).status).toBe('ok');
        });
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

        const chain = { messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: messageKey, nonce }) };
        keyStore.getReceiverChain.and.returnValue(chain as never);
        keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));

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
        const signingPrivate = crypto.getRandomValues(new Uint8Array(32));
        keyStore.getChainSigningKey.and.returnValue(ed25519.getPublicKey(signingPrivate));

        // `messageKeyFor` itself is called synchronously in `decryptOnce` (never awaited) — the
        // genuine in-flight window is inside `openMessage`'s real WebCrypto calls, which this test
        // relies on rather than faking, so it exercises the actual await boundary.
        const chain = {
            messageKeyFor: jasmine.createSpy('messageKeyFor').and.returnValue({ key: new Uint8Array(32) }),
        };
        keyStore.getReceiverChain.and.returnValue(chain as never);

        const raw = await signedMessage('m-race', 0, signingPrivate);
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
            chatApi.sendEnvelope.and.returnValues(
                throwError(() => staleError()),
                of(envelopeMessage('m1', 0))
            );

            await service.sendText(CHAT, 'hello');

            expect(chatApi.sendEnvelope).toHaveBeenCalledTimes(2);
            const [first, second] = [chatApi.sendEnvelope.calls.argsFor(0), chatApi.sendEnvelope.calls.argsFor(1)];
            expect(first[5]).toMatch(UUID_V4);
            expect(second[5]).toBe(first[5]);
            // The retry is a genuine re-seal, not the old ciphertext resent.
            expect(second[1]).not.toEqual(first[1]);
        });

        it('re-seals for details.current_epoch, not the epoch it first tried', async () => {
            chatApi.sendEnvelope.and.returnValues(
                throwError(() => staleError()),
                of(envelopeMessage('m1', 0))
            );

            await service.sendText(CHAT, 'hello');

            expect(keyStore.ensureSenderChain.calls.argsFor(0)).toEqual([CHAT, 1]);
            expect(keyStore.ensureSenderChain.calls.argsFor(1)).toEqual([CHAT, 2]);
            expect(keyStore.invalidateSenderChain).toHaveBeenCalledWith(CHAT, 1);
            // Same server-side epoch as the one it told us about, carried inside the envelope.
            expect(chatApi.sendEnvelope.calls.argsFor(1)[1].epoch).toBe(2);
        });

        it('retries exactly once: a second EPOCH_STALE is surfaced, with the same id both times', async () => {
            chatApi.sendEnvelope.and.returnValue(throwError(() => staleError()));

            await expectAsync(service.sendText(CHAT, 'hello')).toBeRejected();

            expect(chatApi.sendEnvelope).toHaveBeenCalledTimes(2);
            expect(chatApi.sendEnvelope.calls.argsFor(1)[5]).toBe(chatApi.sendEnvelope.calls.argsFor(0)[5]);
        });

        it('does not retry on other failures', async () => {
            chatApi.sendEnvelope.and.returnValue(throwError(() => new HttpErrorResponse({ status: 500 })));

            await expectAsync(service.sendText(CHAT, 'hello')).toBeRejected();

            expect(chatApi.sendEnvelope).toHaveBeenCalledTimes(1);
        });

        it('treats an exhausted EPOCH_CLOSED publish as stale and re-seals once for the fresh epoch', async () => {
            const closed = new RetryLimitExceededError(
                3,
                new HttpErrorResponse({ status: 409, error: { error_code: 'EPOCH_CLOSED' } })
            );
            let calls = 0;
            keyStore.ensureSenderChain.and.callFake(() => {
                calls += 1;
                return calls === 1
                    ? Promise.reject(closed)
                    : Promise.resolve({
                          senderKeyId: 'c0000000-0000-4000-8000-000000000003',
                          chain: new SenderChain(crypto.getRandomValues(new Uint8Array(32))),
                          chainSigningPrivate: crypto.getRandomValues(new Uint8Array(32)),
                      } as never);
            });
            chatApi.sendEnvelope.and.returnValue(of(envelopeMessage('m1', 0)));

            await service.sendText(CHAT, 'hello');

            expect(keyStore.ensureSenderChain).toHaveBeenCalledTimes(2);
            expect(chatApi.sendEnvelope).toHaveBeenCalledTimes(1);
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
            const { key, nonce } = chain.nextMessageKey();
            const plaintext = await openMessage({
                messageKey: key,
                nonce,
                envelope,
                chatId: CHAT,
                senderId: SENDER,
                signingPublic: ed25519.getPublicKey(signingPrivate),
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

        /** The edit response is the server's word too: the result is filed under the id we edited. */
        it('files the edit under the id it asked to edit, as our own, whatever the response names', async () => {
            keyStore.ensureSenderChain.and.resolveTo({
                senderKeyId: SKID,
                chain: new SenderChain(crypto.getRandomValues(new Uint8Array(32))),
                chainSigningPrivate: crypto.getRandomValues(new Uint8Array(32)),
            } as never);
            Object.defineProperty(keyStore, 'currentIdentity', {
                value: { userId: SENDER, deviceId: 'device-1' },
            });
            const elsewhere = {
                ...envelopeMessage('some-other-message', 1),
                chat_id: 'a0000000-0000-4000-8000-0000000000bb',
                sender_id: 'f0000000-0000-4000-8000-00000000000f',
            };
            chatApi.editMessage.and.returnValue(of(elsewhere));

            const result = await service.editText(CHAT, 'm-edit', 'updated text');

            expect(result.id).toBe('m-edit');
            expect(result.chatId).toBe(CHAT);
            expect(result.senderId).toBe(SENDER);
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
            const { key, nonce } = chain.nextMessageKey();
            const plaintext = await openMessage({
                messageKey: key,
                nonce,
                envelope,
                chatId: CHAT,
                senderId: SENDER,
                signingPublic: ed25519.getPublicKey(signingPrivate),
            });
            const parsed = JSON.parse(new TextDecoder().decode(plaintext));
            expect(parsed.text).toBe('updated text');
            expect(parsed.attachmentKeys).toEqual([]);

            expect(result.text).toBe('updated text');
        });
    });
});
