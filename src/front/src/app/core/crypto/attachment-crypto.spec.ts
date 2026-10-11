import { decryptAttachment, encryptAttachment } from './attachment-crypto';

describe('attachment-crypto', () => {
    it('round-trips encrypt/decrypt back to the original bytes', async () => {
        const original = crypto.getRandomValues(new Uint8Array(4096));

        const { blob, key } = await encryptAttachment(original);
        const decrypted = await decryptAttachment(blob, key);

        expect(decrypted).toEqual(original);
    });

    it('throws when decrypting with the wrong key', async () => {
        const original = crypto.getRandomValues(new Uint8Array(256));
        const { blob } = await encryptAttachment(original);
        const wrongKey = crypto.getRandomValues(new Uint8Array(32));

        await expectAsync(decryptAttachment(blob, wrongKey)).toBeRejected();
    });

    it('places the nonce as the first 12 bytes of the blob', async () => {
        const original = crypto.getRandomValues(new Uint8Array(128));
        const { blob, key } = await encryptAttachment(original);

        const nonce = blob.slice(0, 12);
        const ciphertext = blob.slice(12);

        const aesKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
        const plaintext = new Uint8Array(
            await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: nonce as BufferSource },
                aesKey,
                ciphertext as BufferSource
            )
        );

        expect(plaintext).toEqual(original);
    });
});
