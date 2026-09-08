import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { sha512 } from '@noble/hashes/sha2.js';

import {
    b64uDecode,
    b64uEncode,
    concatBytes,
    DS_FINGERPRINT,
    DS_IDENTITY_BIND,
    DS_PREKEY_BIND,
    fromUtf8,
    utf8,
    uuidBytes,
} from './primitives';

/**
 * Identity keys. Client half of `reference/identity.py`.
 *
 * Two keypairs per device, deliberately separate — reusing one key across a signature scheme and a
 * DH scheme is a known cross-protocol hazard:
 *
 *   Ed25519 "signing key"  — signs messages and distributions; the root of authenticity, and what
 *                            a safety number fingerprints.
 *   X25519  "identity key" — receives wrapped sender keys via ECDH.
 *
 * The private halves are wrapped under an Argon2id-derived key and stored server-side, so a
 * database disclosure becomes an offline guessing target. That makes these parameters a security
 * control rather than hygiene.
 */

export const ALGORITHM = 'x25519_ed25519_v1';

export const ARGON2_MEMORY_KIB = 65536;
export const ARGON2_TIME_COST = 3;
export const ARGON2_PARALLELISM = 4;
const SALT_BYTES = 16;
const KEK_BYTES = 32;
const GCM_NONCE_BYTES = 12;

export interface IdentityBundle {
    readonly signingPrivate: Uint8Array;
    readonly signingPublic: Uint8Array;
    readonly identityPrivate: Uint8Array;
    readonly identityPublic: Uint8Array;
    readonly identityKeySignature: Uint8Array;
}

export interface KdfParams {
    kdf: 'argon2id';
    m: number;
    t: number;
    p: number;
    salt: string;
    nonce: string;
}

/** The blob the Ed25519 key signs to vouch for its X25519 counterpart. Binding user and device in
 *  stops a valid (key, signature) pair being transplanted onto another identity. */
export function identityBindingMessage(userId: string, deviceId: string, identityPublic: Uint8Array): Uint8Array {
    return concatBytes(DS_IDENTITY_BIND, uuidBytes(userId), uuidBytes(deviceId), identityPublic);
}

/**
 * The blob the Ed25519 key signs to vouch for a medium-term signed prekey.
 *
 * Its own domain separator, not `DS_IDENTITY_BIND`: both sign a 32-byte X25519 public key for the
 * same (user, device), so sharing one would let a prekey signature be replayed as an identity-key
 * binding and vice versa.
 */
export function prekeyBindingMessage(userId: string, deviceId: string, signedPrekeyPublic: Uint8Array): Uint8Array {
    return concatBytes(DS_PREKEY_BIND, uuidBytes(userId), uuidBytes(deviceId), signedPrekeyPublic);
}

export function signSignedPrekey(
    signingPrivate: Uint8Array,
    userId: string,
    deviceId: string,
    signedPrekeyPublic: Uint8Array
): Uint8Array {
    return ed25519.sign(prekeyBindingMessage(userId, deviceId, signedPrekeyPublic), signingPrivate);
}

/**
 * Check that a device's identity signing key vouches for its prekey.
 *
 * `KeyStoreService.ensureSenderChain` prefers the signed prekey over the identity key as the ECDH
 * recipient, so an unverified prekey would let whoever can write the roster substitute a key they
 * hold — the exact substitution this signature exists to prevent.
 */
export function verifySignedPrekey(
    userId: string,
    deviceId: string,
    signedPrekeyPublic: Uint8Array,
    signingPublic: Uint8Array,
    signature: Uint8Array
): boolean {
    try {
        return ed25519.verify(signature, prekeyBindingMessage(userId, deviceId, signedPrekeyPublic), signingPublic);
    } catch {
        return false;
    }
}

/** A fresh medium-term prekey plus the signature binding it to this identity. */
export function generateSignedPrekey(
    signingPrivate: Uint8Array,
    userId: string,
    deviceId: string
): { prekeyPrivate: Uint8Array; prekeyPublic: Uint8Array; signature: Uint8Array } {
    const prekeyPrivate = x25519.utils.randomSecretKey();
    const prekeyPublic = x25519.getPublicKey(prekeyPrivate);

    return {
        prekeyPrivate,
        prekeyPublic,
        signature: signSignedPrekey(signingPrivate, userId, deviceId, prekeyPublic),
    };
}

export function generateIdentity(userId: string, deviceId: string): IdentityBundle {
    const signingPrivate = ed25519.utils.randomSecretKey();
    const identityPrivate = x25519.utils.randomSecretKey();

    const signingPublic = ed25519.getPublicKey(signingPrivate);
    const identityPublic = x25519.getPublicKey(identityPrivate);

    return {
        signingPrivate,
        signingPublic,
        identityPrivate,
        identityPublic,
        identityKeySignature: ed25519.sign(identityBindingMessage(userId, deviceId, identityPublic), signingPrivate),
    };
}

export function verifyIdentityBinding(
    userId: string,
    deviceId: string,
    identityPublic: Uint8Array,
    signingPublic: Uint8Array,
    signature: Uint8Array
): boolean {
    try {
        return ed25519.verify(signature, identityBindingMessage(userId, deviceId, identityPublic), signingPublic);
    } catch {
        return false;
    }
}

export function deriveKek(password: string, salt: Uint8Array): Uint8Array {
    return argon2id(utf8(password), salt, {
        t: ARGON2_TIME_COST,
        m: ARGON2_MEMORY_KIB,
        p: ARGON2_PARALLELISM,
        dkLen: KEK_BYTES,
    });
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface WrappedBundle {
    encryptedPrivateBundle: string;
    kdfParams: KdfParams;
}

export async function wrapPrivateBundle(bundle: IdentityBundle, password: string): Promise<WrappedBundle> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));

    const kek = await importAesKey(deriveKek(password, salt));

    const plaintext = utf8(
        JSON.stringify({
            signing_private: b64uEncode(bundle.signingPrivate),
            identity_private: b64uEncode(bundle.identityPrivate),
        })
    );

    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, kek, plaintext as BufferSource)
    );

    return {
        encryptedPrivateBundle: b64uEncode(ciphertext),
        kdfParams: {
            kdf: 'argon2id',
            m: ARGON2_MEMORY_KIB,
            t: ARGON2_TIME_COST,
            p: ARGON2_PARALLELISM,
            salt: b64uEncode(salt),
            nonce: b64uEncode(nonce),
        },
    };
}

/** Inverse of wrapPrivateBundle. Throws on a wrong password (GCM tag failure). */
export async function unwrapPrivateBundle(
    wrapped: string,
    kdfParams: KdfParams,
    password: string
): Promise<{ signingPrivate: Uint8Array; identityPrivate: Uint8Array }> {
    const kekRaw = argon2id(utf8(password), b64uDecode(kdfParams.salt), {
        t: kdfParams.t,
        m: kdfParams.m,
        p: kdfParams.p,
        dkLen: KEK_BYTES,
    });

    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64uDecode(kdfParams.nonce) as BufferSource },
        await importAesKey(kekRaw),
        b64uDecode(wrapped) as BufferSource
    );

    const payload = JSON.parse(fromUtf8(new Uint8Array(plaintext))) as {
        signing_private: string;
        identity_private: string;
    };

    return {
        signingPrivate: b64uDecode(payload.signing_private),
        identityPrivate: b64uDecode(payload.identity_private),
    };
}

/**
 * A stable 60-digit fingerprint two users compare out-of-band.
 *
 * Inputs are sorted so both sides compute the same value. This is the only defence against a
 * malicious server substituting a public key, so it must be surfaced in the UI and must visibly
 * change when a peer's key changes.
 */
export function safetyNumber(signingPublicA: Uint8Array, signingPublicB: Uint8Array): string {
    const [first, second] = [signingPublicA, signingPublicB].sort((a, b) => {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] !== b[i]) {
                return a[i] - b[i];
            }
        }
        return a.length - b.length;
    });

    // SHA-512, not SHA-256: 12 groups consume 48 bytes and a 32-byte digest cannot fill them.
    const raw = sha512(concatBytes(DS_FINGERPRINT, first, second));
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    const groups: string[] = [];
    for (let i = 0; i < 48; i += 4) {
        groups.push(String(view.getUint32(i, false) % 100000).padStart(5, '0'));
    }
    return groups.join(' ');
}
