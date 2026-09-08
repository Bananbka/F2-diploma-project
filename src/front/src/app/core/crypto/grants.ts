import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
    b64uDecode,
    b64uEncode,
    concatBytes,
    DS_GRANT,
    DS_MEMBER_SET,
    DS_SENDER_KEY,
    u32be,
    utf8,
    uuidBytes,
} from './primitives';

/**
 * Sender key distribution. Client half of `reference/grants.py`.
 *
 * Two things here carry most of the security weight:
 *
 * 1. The distribution signature — a grant alone says nothing about who produced it, so the sender
 *    signs the chain's signing key with its long-term identity.
 * 2. The member set hash — an epoch commits to an exact device set. Before wrapping, a client
 *    recomputes the hash from the roster and refuses on mismatch. Without that check a malicious
 *    server silently adds a ghost device and every sender dutifully wraps for it, with the
 *    cryptography behaving perfectly. **The backend cannot enforce this. It lives here.**
 */

export const WRAP_ALGORITHM = 'x25519_hkdf_sha256_aes256gcm_v1';
export const SENDER_KEY_ALGORITHM = 'hkdf_sha256_aes256gcm_v1';

const NONCE_BYTES = 12;
const WRAP_KEY_BYTES = 32;

/** Commit to an epoch's exact device set. Sorted so every participant derives the same value. */
export function computeMemberSetHash(deviceIds: readonly string[]): string {
    const joined = [...deviceIds].map(String).sort().join('|');
    const digest = sha256(concatBytes(DS_MEMBER_SET, utf8(joined)));

    return Array.from(digest)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export function distributionSigningPayload(
    chatId: string,
    epoch: number,
    senderKeyId: string,
    signingPublic: Uint8Array,
    chainStartIndex: number
): Uint8Array {
    return concatBytes(
        DS_SENDER_KEY,
        uuidBytes(chatId),
        u32be(epoch),
        uuidBytes(senderKeyId),
        signingPublic,
        u32be(chainStartIndex)
    );
}

export function signDistribution(params: {
    identitySigningPrivate: Uint8Array;
    chatId: string;
    epoch: number;
    senderKeyId: string;
    chainSigningPublic: Uint8Array;
    chainStartIndex: number;
}): string {
    return b64uEncode(
        ed25519.sign(
            distributionSigningPayload(
                params.chatId,
                params.epoch,
                params.senderKeyId,
                params.chainSigningPublic,
                params.chainStartIndex
            ),
            params.identitySigningPrivate
        )
    );
}

export function verifyDistribution(params: {
    identitySigningPublic: Uint8Array;
    signature: string;
    chatId: string;
    epoch: number;
    senderKeyId: string;
    chainSigningPublic: Uint8Array;
    chainStartIndex: number;
}): boolean {
    try {
        return ed25519.verify(
            b64uDecode(params.signature),
            distributionSigningPayload(
                params.chatId,
                params.epoch,
                params.senderKeyId,
                params.chainSigningPublic,
                params.chainStartIndex
            ),
            params.identitySigningPublic
        );
    } catch {
        return false;
    }
}

/** Binds a wrapped key to exactly one (chat, epoch, sender, recipient, ephemeral) tuple. */
export function buildGrantAad(params: {
    chatId: string;
    epoch: number;
    senderKeyId: string;
    senderDeviceId: string;
    recipientDeviceId: string;
    ephemeralPublic: Uint8Array;
}): Uint8Array {
    return concatBytes(
        DS_GRANT,
        uuidBytes(params.chatId),
        u32be(params.epoch),
        uuidBytes(params.senderKeyId),
        uuidBytes(params.senderDeviceId),
        uuidBytes(params.recipientDeviceId),
        params.ephemeralPublic
    );
}

function deriveWrapKey(
    sharedSecret: Uint8Array,
    chatId: string,
    epoch: number,
    aad: Uint8Array
): { wrapKey: Uint8Array; nonce: Uint8Array } {
    const salt = sha256(concatBytes(uuidBytes(chatId), u32be(epoch)));
    const okm = hkdf(sha256, sharedSecret, salt, aad, WRAP_KEY_BYTES + NONCE_BYTES);

    return { wrapKey: okm.slice(0, WRAP_KEY_BYTES), nonce: okm.slice(WRAP_KEY_BYTES) };
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface WrappedGrant {
    ephemeralPublicKey: string;
    wrappedChainKey: string;
}

/**
 * Wrap a chain key for one recipient device.
 *
 * `recipientPublic` should be the recipient's signed prekey when available — that gives forward
 * secrecy for the grant once the prekey rotates — falling back to their long-term identity key.
 */
export async function wrapChainKey(params: {
    chainKey: Uint8Array;
    chainStartIndex: number;
    recipientPublic: Uint8Array;
    chatId: string;
    epoch: number;
    senderKeyId: string;
    senderDeviceId: string;
    recipientDeviceId: string;
}): Promise<WrappedGrant> {
    const ephemeralPrivate = x25519.utils.randomSecretKey();
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);

    const sharedSecret = x25519.getSharedSecret(ephemeralPrivate, params.recipientPublic);

    const aad = buildGrantAad({ ...params, ephemeralPublic });
    const { wrapKey, nonce } = deriveWrapKey(sharedSecret, params.chatId, params.epoch, aad);

    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
            await importAesKey(wrapKey),
            concatBytes(params.chainKey, u32be(params.chainStartIndex)) as BufferSource
        )
    );

    return {
        ephemeralPublicKey: b64uEncode(ephemeralPublic),
        wrappedChainKey: b64uEncode(concatBytes(nonce, ciphertext)),
    };
}

/** Inverse of wrapChainKey. Any mismatch in the bound fields fails closed as a GCM tag error. */
export async function unwrapChainKey(params: {
    wrapped: string;
    ephemeralPublic: string;
    recipientPrivate: Uint8Array;
    chatId: string;
    epoch: number;
    senderKeyId: string;
    senderDeviceId: string;
    recipientDeviceId: string;
}): Promise<{ chainKey: Uint8Array; chainStartIndex: number }> {
    const ephemeralPublic = b64uDecode(params.ephemeralPublic);
    const blob = b64uDecode(params.wrapped);
    const nonce = blob.slice(0, NONCE_BYTES);
    const ciphertext = blob.slice(NONCE_BYTES);

    const sharedSecret = x25519.getSharedSecret(params.recipientPrivate, ephemeralPublic);

    const aad = buildGrantAad({ ...params, ephemeralPublic });
    const { wrapKey } = deriveWrapKey(sharedSecret, params.chatId, params.epoch, aad);

    const plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
            await importAesKey(wrapKey),
            ciphertext as BufferSource
        )
    );

    return {
        chainKey: plaintext.slice(0, 32),
        chainStartIndex: new DataView(plaintext.buffer, plaintext.byteOffset + 32, 4).getUint32(0, false),
    };
}
