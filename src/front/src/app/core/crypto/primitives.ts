/**
 * Shared encoding and domain-separation primitives for wire format v1.
 *
 * This is the client half of `api/app/domains/crypto/reference/primitives.py`. Every byte-level
 * encoding lives here, in one place, because a mismatch between the two implementations shows up
 * as an opaque GCM tag failure rather than a useful error.
 *
 * See docs/crypto-spec-v1.md — that spec is normative and these values must not drift from it.
 */

const encoder = new TextEncoder();

/** Domain separators. Every signed or AEAD-bound blob starts with one, so a value produced for
 *  one purpose can never be replayed as a value for another. */
export const DS_IDENTITY_BIND = encoder.encode('NS-v1-idbind');
export const DS_PREKEY_BIND = encoder.encode('NS-v1-prekeybind');
export const DS_MESSAGE = encoder.encode('NS-v1-msg');
export const DS_MESSAGE_KEY = encoder.encode('NS-v1-msgkey');
export const DS_CHAIN = encoder.encode('NS-v1-chain');
export const DS_GRANT = encoder.encode('NS-v1-grant');
export const DS_SENDER_KEY = encoder.encode('NS-v1-skdm');
export const DS_MEMBER_SET = encoder.encode('NS-v1-memberset');
export const DS_CHANNEL_POST = encoder.encode('NS-v1-post');
export const DS_FINGERPRINT = encoder.encode('NS-v1-fingerprint');

export const VERSION = 1;

/** base64url without padding. Padding is stripped so values are URL- and JSON-clean. */
export function b64uEncode(raw: Uint8Array): string {
    let binary = '';
    for (const byte of raw) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);

    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

/** 4-byte big-endian. Used for every integer in AAD and signature inputs. */
export function u32be(value: number): Uint8Array {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`value out of range for u32: ${value}`);
    }

    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
}

/**
 * UUIDs are bound as their 16 raw bytes, never as a hyphenated string.
 *
 * Getting this wrong is the single easiest way to break interop with the backend, because the
 * string form is 36 bytes and would still "work" locally while failing against Python.
 */
export function uuidBytes(value: string): Uint8Array {
    const hex = value.replace(/-/g, '');
    if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new TypeError(`not a uuid: ${value}`);
    }

    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);

    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export function utf8(value: string): Uint8Array {
    return encoder.encode(value);
}

export function fromUtf8(raw: Uint8Array): string {
    return new TextDecoder().decode(raw);
}

/** Constant-time comparison, for anything derived from secret material. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }

    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}
