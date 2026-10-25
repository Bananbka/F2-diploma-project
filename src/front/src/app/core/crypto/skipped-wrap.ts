import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { b64uDecode, b64uEncode, concatBytes, DS_SKIPPED, DS_SKIPPED_KEY, u32be, uuidBytes } from './primitives';
import { MESSAGE_KEY_BYTES, MessageKey, NONCE_BYTES } from './ratchet';

/**
 * At-rest wrapping of retained skipped message keys. Local storage format only: it never crosses
 * the wire, so there is no Python counterpart and `npm run interop` has no vector for it.
 * Specified in crypto-spec-v1.md, section "Retained skipped keys at rest".
 *
 *     wrap_key = HKDF-SHA256(KEK, info="NS-v1-skipped-key", L=32)
 *     ct       = AES-256-GCM(wrap_key, iv, MK_i || N_i, aad)       iv: 12 random bytes, fresh per write
 *     aad      = "NS-v1-skipped" || uuid(user) || uuid(chat) || u32be(epoch)
 *                || uuid(sender_key_id) || u32be(index)
 *
 * The AAD is what stops entries being swapped: an entry moved to another chat, chain, index or
 * account fails the tag check rather than decrypting to a valid-looking but wrong key.
 */

export interface SkippedKeyLocation {
    userId: string;
    chatId: string;
    epoch: number;
    senderKeyId: string;
    index: number;
}

export interface WrappedSkippedKey {
    iv: string;
    ct: string;
}

function aadFor(where: SkippedKeyLocation): Uint8Array {
    return concatBytes(
        DS_SKIPPED,
        uuidBytes(where.userId),
        uuidBytes(where.chatId),
        u32be(where.epoch),
        uuidBytes(where.senderKeyId),
        u32be(where.index)
    );
}

async function wrapKey(kek: Uint8Array): Promise<CryptoKey> {
    // A subkey rather than the KEK itself, so the bundle seal and this store never share a key.
    const raw = hkdf(sha256, kek, undefined, DS_SKIPPED_KEY, 32);
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function wrapSkippedKey(
    kek: Uint8Array,
    where: SkippedKeyLocation,
    messageKey: MessageKey
): Promise<WrappedSkippedKey> {
    const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ct = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aadFor(where) as BufferSource },
            await wrapKey(kek),
            concatBytes(messageKey.key, messageKey.nonce) as BufferSource
        )
    );
    return { iv: b64uEncode(iv), ct: b64uEncode(ct) };
}

/** Throws on a wrong KEK, a tampered record, or a record presented under a different location. */
export async function unwrapSkippedKey(
    kek: Uint8Array,
    where: SkippedKeyLocation,
    wrapped: WrappedSkippedKey
): Promise<MessageKey> {
    const plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: b64uDecode(wrapped.iv) as BufferSource,
                additionalData: aadFor(where) as BufferSource,
            },
            await wrapKey(kek),
            b64uDecode(wrapped.ct) as BufferSource
        )
    );
    if (plaintext.length !== MESSAGE_KEY_BYTES + NONCE_BYTES) {
        throw new Error('retained key has the wrong length');
    }
    return { key: plaintext.slice(0, MESSAGE_KEY_BYTES), nonce: plaintext.slice(MESSAGE_KEY_BYTES) };
}
