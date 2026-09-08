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
        created_at: '2026-01-01T00:00:00Z',
        attachments: null,
        is_read: false,
        is_pinned: false,
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
});
