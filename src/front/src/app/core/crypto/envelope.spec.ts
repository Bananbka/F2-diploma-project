import { ed25519 } from '@noble/curves/ed25519.js';

import { isValidChainIndex, MessageEnvelope, openMessage, sealMessage, verifyEnvelopeSignature } from './envelope';
import { b64uEncode, utf8 } from './primitives';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const SENDER = 'b0000000-0000-4000-8000-000000000002';
const SKID = 'c0000000-0000-4000-8000-000000000003';

describe('envelope', () => {
    let messageKey: Uint8Array;
    let signingPrivate: Uint8Array;
    let signingPublic: Uint8Array;
    let envelope: MessageEnvelope;

    beforeEach(async () => {
        messageKey = crypto.getRandomValues(new Uint8Array(32));
        signingPrivate = crypto.getRandomValues(new Uint8Array(32));
        signingPublic = ed25519.getPublicKey(signingPrivate);
        envelope = await sealMessage({
            messageKey,
            nonce: crypto.getRandomValues(new Uint8Array(12)),
            signingPrivate,
            chatId: CHAT,
            epoch: 1,
            senderId: SENDER,
            senderKeyId: SKID,
            chainIndex: 4,
            plaintext: utf8('hi'),
        });
    });

    it('opens a correctly signed envelope', async () => {
        const plaintext = await openMessage({ messageKey, envelope, chatId: CHAT, senderId: SENDER, signingPublic });
        expect(new TextDecoder().decode(plaintext)).toBe('hi');
    });

    /** F-L8: there is no longer a way to open without verifying. */
    it('refuses to open when no signing key is supplied', async () => {
        await expectAsync(
            openMessage({
                messageKey,
                envelope,
                chatId: CHAT,
                senderId: SENDER,
                signingPublic: undefined as unknown as Uint8Array,
            })
        ).toBeRejectedWithError(/signing key is required/);
    });

    it('refuses to open under the wrong signing key', async () => {
        const other = ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)));
        await expectAsync(
            openMessage({ messageKey, envelope, chatId: CHAT, senderId: SENDER, signingPublic: other })
        ).toBeRejectedWithError(/does not verify/);
    });

    it('verifies the signature with public material only', () => {
        expect(verifyEnvelopeSignature(envelope, signingPublic, CHAT, SENDER)).toBeTrue();
        const tampered = { ...envelope, sig: b64uEncode(new Uint8Array(64)) };
        expect(verifyEnvelopeSignature(tampered, signingPublic, CHAT, SENDER)).toBeFalse();
        expect(verifyEnvelopeSignature({ ...envelope, idx: 1.5 }, signingPublic, CHAT, SENDER)).toBeFalse();
    });

    it('accepts only indices the AAD can encode', () => {
        expect(isValidChainIndex(0)).toBeTrue();
        expect(isValidChainIndex(0xffffffff)).toBeTrue();
        for (const bad of [1.5, -1, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined]) {
            expect(isValidChainIndex(bad)).withContext(String(bad)).toBeFalse();
        }
    });
});
