import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { MessageResponse } from '../models/crypto.model';
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

describe('MessageService', () => {
    let service: MessageService;
    let keyStore: jasmine.SpyObj<KeyStoreService>;
    let chatApi: jasmine.SpyObj<ChatApiService>;

    beforeEach(() => {
        keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', [
            'getReceiverChain',
            'getChainSigningKey',
            'ingestDistributions',
        ]);
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['getMessages']);

        const cryptoApi = jasmine.createSpyObj<CryptoApiService>('CryptoApiService', ['getChatKeys']);
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
});
