import { ReceiverChain, SenderChain } from './ratchet';

describe('ReceiverChain.messageKeyFor index validation', () => {
    function pair(): { sender: SenderChain; receiver: ReceiverChain } {
        const chainKey = crypto.getRandomValues(new Uint8Array(32));
        return { sender: new SenderChain(chainKey.slice()), receiver: new ReceiverChain(chainKey.slice()) };
    }

    /**
     * 1.5 used to pass the MAX_SKIP comparison, walk the chain forward, and only then throw inside
     * `u32be` when the AAD was built — leaving the chain advanced past keys it never handed out.
     */
    for (const idx of [1.5, -1, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`throws for index ${idx} without advancing the chain`, () => {
            const { sender, receiver } = pair();

            expect(() => receiver.messageKeyFor(idx)).toThrowError(RangeError, /invalid chain index/);
            expect(receiver.index).toBe(0);
            expect(receiver.skipped.size).toBe(0);

            // Still in step with the sender.
            const sent = sender.nextMessageKey();
            expect(receiver.messageKeyFor(0).key).toEqual(sent.key);
        });
    }

    it('accepts ordinary integer indices', () => {
        const { sender, receiver } = pair();
        const keys = [sender.nextMessageKey(), sender.nextMessageKey(), sender.nextMessageKey()];

        expect(receiver.messageKeyFor(2).key).toEqual(keys[2].key);
        expect(receiver.messageKeyFor(0).key).toEqual(keys[0].key);
        expect(receiver.messageKeyFor(1).key).toEqual(keys[1].key);
    });
});
