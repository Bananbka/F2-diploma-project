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
    // Medium-term X25519 prekey. Present from `generateIdentity` onward (see its docstring) so its
    // private half is already inside the sealed bundle by the time a rotation needs somewhere to
    // put a new one. Optional because a bundle unwrapped from storage sealed before rotation was
    // re-enabled has none — see `unwrapPrivateBundle` — and a throwaway chain identity (minted to
    // sign a single sender-key distribution) has no business publishing one either.
    readonly prekeyPrivate?: Uint8Array;
    readonly prekeyPublic?: Uint8Array;
    readonly signedPrekeySignature?: Uint8Array;
    // The *previous* generation's prekey private half, retained for exactly one rotation cycle —
    // see crypto-spec-v1.md §2.1.2/§2.2 and `KeyStoreService.rotatePrekey`. A grant published
    // against the outgoing signed prekey but not yet ingested at the moment of rotation would
    // otherwise become permanently unopenable. Absent for every bundle before its first rotation,
    // and discarded (replaced by the generation being superseded) on every rotation after that —
    // it is a one-cycle grace window, not an accumulated history.
    readonly prevPrekeyPrivate?: Uint8Array;
}

/** The private-key fields `wrapPrivateBundle`/`sealPrivateBundle` actually seal. Deliberately not
 *  all of `IdentityBundle` — the public halves and the identity-binding signature never enter the
 *  sealed blob, so a caller re-sealing an already-published bundle (rotation, change-password)
 *  does not need to carry them around just to satisfy the type. */
export interface PrivateBundleFields {
    readonly signingPrivate: Uint8Array;
    readonly identityPrivate: Uint8Array;
    readonly prekeyPrivate?: Uint8Array;
    readonly prevPrekeyPrivate?: Uint8Array;
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

/**
 * Generate a device's full keypair set. Client half of `reference/identity.generate_identity`.
 *
 * `withPrekey = true` by default: a real client mints the signed prekey at registration time,
 * alongside the identity keypair, precisely so its private half is available immediately after
 * unlock with no extra password prompt — see `KeyStoreService.rotatePrekey` and
 * crypto-spec-v1.md §2.1.2/§2.2. Pass `withPrekey = false` to model a bundle sealed before prekey
 * rotation was re-enabled, or to build a throwaway identity that has no business publishing a
 * prekey at all (e.g. a chain identity minted to sign one sender-key distribution).
 */
export function generateIdentity(userId: string, deviceId: string, withPrekey = true): IdentityBundle {
    const signingPrivate = ed25519.utils.randomSecretKey();
    const identityPrivate = x25519.utils.randomSecretKey();

    const signingPublic = ed25519.getPublicKey(signingPrivate);
    const identityPublic = x25519.getPublicKey(identityPrivate);

    const bundle: IdentityBundle = {
        signingPrivate,
        signingPublic,
        identityPrivate,
        identityPublic,
        identityKeySignature: ed25519.sign(identityBindingMessage(userId, deviceId, identityPublic), signingPrivate),
    };

    if (!withPrekey) {
        return bundle;
    }

    const { prekeyPrivate, prekeyPublic, signature } = generateSignedPrekey(signingPrivate, userId, deviceId);
    return { ...bundle, prekeyPrivate, prekeyPublic, signedPrekeySignature: signature };
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
    // The Argon2id-derived key this call just produced (or reused). Never sent over the wire —
    // callers pick `encryptedPrivateBundle`/`kdfParams` off this explicitly — but keeping it here
    // lets `KeyStoreService` hold onto it in memory and re-seal later (rotation) without prompting
    // for the password again.
    kek: Uint8Array;
}

async function encryptBundlePayload(
    bundle: PrivateBundleFields,
    kekRaw: Uint8Array
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
    const kek = await importAesKey(kekRaw);

    const payload: Record<string, string> = {
        signing_private: b64uEncode(bundle.signingPrivate),
        identity_private: b64uEncode(bundle.identityPrivate),
    };
    // Absent, not null, when there is no prekey — matches `wrap_private_bundle` in the Python
    // reference, so a bundle sealed before rotation existed and one sealed by a client that chose
    // not to publish a prekey are indistinguishable from a bundle with genuinely nothing to
    // unwrap here.
    if (bundle.prekeyPrivate) {
        payload['prekey_private'] = b64uEncode(bundle.prekeyPrivate);
    }
    // Same convention: absent, not null, when there is no retained previous generation — every
    // bundle before this device's first rotation, and any bundle re-sealed after two rotations
    // have elapsed without the grace-window key being carried forward.
    if (bundle.prevPrekeyPrivate) {
        payload['prev_prekey_private'] = b64uEncode(bundle.prevPrekeyPrivate);
    }

    const plaintext = utf8(JSON.stringify(payload));
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, kek, plaintext as BufferSource)
    );

    return { ciphertext, nonce };
}

export async function wrapPrivateBundle(bundle: PrivateBundleFields, password: string): Promise<WrappedBundle> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const kekRaw = deriveKek(password, salt);
    const { ciphertext, nonce } = await encryptBundlePayload(bundle, kekRaw);

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
        kek: kekRaw,
    };
}

/**
 * Re-seal a bundle under a KEK already derived from a previous unlock or `wrapPrivateBundle` call
 * — the point is to rotate the signed prekey (see `KeyStoreService.rotatePrekey`) without ever
 * needing the password again, per crypto-spec-v1.md §2.1.2. Reuses the existing Argon2id
 * salt/parameters, since the password has not changed and re-deriving from it would just recompute
 * the same KEK at real cost; only the AES-GCM nonce, and the plaintext (now carrying the new
 * `prekeyPrivate`), are fresh.
 */
export async function sealPrivateBundle(
    bundle: PrivateBundleFields,
    kek: Uint8Array,
    kdfParams: KdfParams
): Promise<WrappedBundle> {
    const { ciphertext, nonce } = await encryptBundlePayload(bundle, kek);

    return {
        encryptedPrivateBundle: b64uEncode(ciphertext),
        kdfParams: { ...kdfParams, nonce: b64uEncode(nonce) },
        kek,
    };
}

/**
 * Inverse of wrapPrivateBundle/sealPrivateBundle. Throws on a wrong password (GCM tag failure).
 *
 * `prekeyPrivate` is only present in the result when the sealed plaintext carried one — a bundle
 * sealed before prekey rotation was re-enabled has no such field, and that absence (not a null) is
 * the entire backward-compat story: there is nothing server-side to migrate, since the blob is
 * opaque, so the field simply starts appearing the next time this device's bundle is re-sealed.
 */
export async function unwrapPrivateBundle(
    wrapped: string,
    kdfParams: KdfParams,
    password: string
): Promise<{
    signingPrivate: Uint8Array;
    identityPrivate: Uint8Array;
    prekeyPrivate?: Uint8Array;
    prevPrekeyPrivate?: Uint8Array;
    kek: Uint8Array;
}> {
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
        prekey_private?: string;
        prev_prekey_private?: string;
    };

    const result: {
        signingPrivate: Uint8Array;
        identityPrivate: Uint8Array;
        prekeyPrivate?: Uint8Array;
        prevPrekeyPrivate?: Uint8Array;
        kek: Uint8Array;
    } = {
        signingPrivate: b64uDecode(payload.signing_private),
        identityPrivate: b64uDecode(payload.identity_private),
        kek: kekRaw,
    };
    if (payload.prekey_private !== undefined) {
        result.prekeyPrivate = b64uDecode(payload.prekey_private);
    }
    if (payload.prev_prekey_private !== undefined) {
        result.prevPrekeyPrivate = b64uDecode(payload.prev_prekey_private);
    }
    return result;
}

/**
 * A stable 60-digit fingerprint two users compare out-of-band.
 *
 * Inputs are sorted so both sides compute the same value. This is the only defence against a
 * malicious server substituting a public key, so it must be surfaced in the UI and must visibly
 * change when a peer's key changes.
 */
/**
 * Collapse all of a user's active device signing keys into one 32-byte value.
 *
 * A safety number is a property of a person, but keys belong to devices. Built from a single
 * arbitrarily-chosen device key, the number depended on row order and — worse — did not change
 * when the peer gained a device, so a device the server planted would not have shown up as a key
 * change. Every active key contributes, sorted so ordering cannot alter the result.
 */
export function userFingerprintMaterial(signingPublics: readonly Uint8Array[]): Uint8Array {
    const sorted = [...signingPublics].sort(compareBytes);

    const parts: Uint8Array[] = [DS_FINGERPRINT];
    for (const key of sorted) {
        const length = new Uint8Array(2);
        new DataView(length.buffer).setUint16(0, key.length, false);
        parts.push(length, key);
    }

    return sha512(concatBytes(...parts)).slice(0, 32);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return a.length - b.length;
}

export function safetyNumber(signingPublicA: Uint8Array, signingPublicB: Uint8Array): string {
    const [first, second] = [signingPublicA, signingPublicB].sort(compareBytes);

    // SHA-512, not SHA-256: 12 groups consume 48 bytes and a 32-byte digest cannot fill them.
    const raw = sha512(concatBytes(DS_FINGERPRINT, first, second));
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    const groups: string[] = [];
    for (let i = 0; i < 48; i += 4) {
        groups.push(String(view.getUint32(i, false) % 100000).padStart(5, '0'));
    }
    return groups.join(' ');
}
