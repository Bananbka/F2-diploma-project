import { deriveMessageKey, generateChainKey, MessageKey, ReceiverChain } from './ratchet';
import { SkippedKeyLocation, unwrapSkippedKey, wrapSkippedKey } from './skipped-wrap';

const WHERE: SkippedKeyLocation = {
    userId: 'a0000000-0000-4000-8000-000000000001',
    chatId: 'c0000000-0000-4000-8000-000000000003',
    epoch: 4,
    senderKeyId: 'e0000000-0000-4000-8000-000000000005',
    index: 7,
};

describe('skipped key wrapping', () => {
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const mk: MessageKey = deriveMessageKey(generateChainKey());

    it('round-trips', async () => {
        const wrapped = await wrapSkippedKey(kek, WHERE, mk);
        const opened = await unwrapSkippedKey(kek, WHERE, wrapped);
        expect(opened.key).toEqual(mk.key);
        expect(opened.nonce).toEqual(mk.nonce);
    });

    it('uses a fresh IV and so different ciphertext for the same input', async () => {
        const a = await wrapSkippedKey(kek, WHERE, mk);
        const b = await wrapSkippedKey(kek, WHERE, mk);
        expect(a.iv).not.toBe(b.iv);
        expect(a.ct).not.toBe(b.ct);
    });

    it('fails under a different KEK', async () => {
        const wrapped = await wrapSkippedKey(kek, WHERE, mk);
        await expectAsync(unwrapSkippedKey(crypto.getRandomValues(new Uint8Array(32)), WHERE, wrapped)).toBeRejected();
    });

    for (const [field, other] of [
        ['userId', { userId: 'a0000000-0000-4000-8000-0000000000ff' }],
        ['chatId', { chatId: 'c0000000-0000-4000-8000-0000000000ff' }],
        ['epoch', { epoch: 5 }],
        ['senderKeyId', { senderKeyId: 'e0000000-0000-4000-8000-0000000000ff' }],
        ['index', { index: 8 }],
    ] as const) {
        it(`fails when presented under a different ${field}`, async () => {
            const wrapped = await wrapSkippedKey(kek, WHERE, mk);
            await expectAsync(unwrapSkippedKey(kek, { ...WHERE, ...other }, wrapped)).toBeRejected();
        });
    }
});

describe('ReceiverChain skipped observer', () => {
    it('reports retained and consumed indices, and does not re-report seeded ones', () => {
        const ck = generateChainKey();
        const retained: number[] = [];
        const consumed: number[] = [];

        const seeded = new ReceiverChain(ck);
        seeded.restoreSkipped(new Map([[1, deriveMessageKey(ck)]]));
        seeded.skippedObserver = { retained: (i) => retained.push(i), consumed: (i) => consumed.push(i) };

        seeded.messageKeyFor(3);
        expect(retained).toEqual([0, 2]);

        seeded.messageKeyFor(1);
        expect(consumed).toEqual([1]);
    });
});
