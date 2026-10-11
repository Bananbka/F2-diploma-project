import { concatBytes } from './primitives';

/**
 * Attachment-at-rest encryption. Client half of `docs/crypto-spec-v1.md` §4.5.
 *
 * Deliberately a separate, small module rather than an extension of `envelope.ts`: it is plain
 * AES-256-GCM with no AAD and no signature, because the only place that authentication can
 * meaningfully live is the envelope that carries the key. A recipient can only ever obtain this
 * key by first opening the message envelope — the member-set verification, signature check and
 * epoch binding that already gate that open are what stand behind the attachment too. Encrypting
 * the attachment under its own domain separator and binding it to the message AAD the way
 * `envelope.ts` binds ciphertext would buy nothing extra and would require plumbing chat/sender
 * context through file upload, which has none of that context today.
 *
 *     blob = nonce(12) || AES-256-GCM(key, nonce, bytes)
 *
 * The key is random per attachment and never derived from anything else, so losing one key
 * exposes exactly one file.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface EncryptedAttachment {
    /** `nonce || ciphertext`, ready to upload as one opaque blob. */
    blob: Uint8Array;
    /** Raw 32-byte key. Never sent over HTTP — only ever travels inside a sealed message envelope. */
    key: Uint8Array;
}

/** Encrypt attachment bytes under a freshly generated random key. */
export async function encryptAttachment(bytes: Uint8Array): Promise<EncryptedAttachment> {
    const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce as BufferSource },
            await importAesKey(key),
            bytes as BufferSource
        )
    );

    return { blob: concatBytes(nonce, ciphertext), key };
}

/** Inverse of `encryptAttachment`. A wrong key or tampered blob fails closed as a GCM tag error. */
export async function decryptAttachment(blob: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    const nonce = blob.slice(0, NONCE_BYTES);
    const ciphertext = blob.slice(NONCE_BYTES);

    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        await importAesKey(key),
        ciphertext as BufferSource
    );

    return new Uint8Array(plaintext);
}
