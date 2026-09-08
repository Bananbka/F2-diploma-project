import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { DS_CHAIN, DS_MESSAGE_KEY } from './primitives';

/**
 * Symmetric sender-key ratchet. Client half of `reference/ratchet.py`.
 *
 *     CK_0        random 32 bytes
 *     MK_i, N_i = HKDF(CK_i, info="NS-v1-msgkey", L=44)
 *     CK_{i+1}  = HKDF(CK_i, info="NS-v1-chain",  L=32)
 *
 * The nonce is derived rather than random. Since the message key is already unique per index, a
 * derived nonce makes GCM (key, nonce) reuse structurally impossible — you cannot reintroduce it
 * by mishandling a random source.
 */

export const CHAIN_KEY_BYTES = 32;
export const MESSAGE_KEY_BYTES = 32;
export const NONCE_BYTES = 12;

/** Bound on how far ahead we derive to service an out-of-order message. Unbounded derivation is a
 *  denial-of-service vector: a peer could claim index 2**31 and force that many HKDF rounds. */
export const MAX_SKIP = 2000;

export interface MessageKey {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
}

export function generateChainKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(CHAIN_KEY_BYTES));
}

export function deriveMessageKey(chainKey: Uint8Array): MessageKey {
    const okm = hkdf(sha256, chainKey, undefined, DS_MESSAGE_KEY, MESSAGE_KEY_BYTES + NONCE_BYTES);

    return {
        key: okm.slice(0, MESSAGE_KEY_BYTES),
        nonce: okm.slice(MESSAGE_KEY_BYTES),
    };
}

export function advanceChain(chainKey: Uint8Array): Uint8Array {
    return hkdf(sha256, chainKey, undefined, DS_CHAIN, CHAIN_KEY_BYTES);
}

/** Sending side. Owns a chain key and yields one message key per call. */
export class SenderChain {
    private chainKey: Uint8Array;
    public index: number;

    constructor(chainKey: Uint8Array, index = 0) {
        this.chainKey = chainKey;
        this.index = index;
    }

    nextMessageKey(): MessageKey & { index: number } {
        const derived = deriveMessageKey(this.chainKey);
        const usedIndex = this.index;

        // Ratchet immediately and drop the previous chain key: once this returns, the key that
        // produced `derived` no longer exists. This is what provides forward secrecy.
        this.chainKey = advanceChain(this.chainKey);
        this.index += 1;

        return { ...derived, index: usedIndex };
    }
}

/**
 * Receiving side, tolerant of out-of-order and dropped messages.
 *
 * Keys for skipped indices are retained so a late message still opens. A real client must persist
 * `skipped` alongside the chain state and should expire it — retained message keys are exactly the
 * material that undermines forward secrecy if kept forever.
 */
export class ReceiverChain {
    private chainKey: Uint8Array;
    public index: number;
    public readonly skipped = new Map<number, MessageKey>();

    constructor(chainKey: Uint8Array, index = 0) {
        this.chainKey = chainKey;
        this.index = index;
    }

    messageKeyFor(targetIndex: number): MessageKey {
        const cached = this.skipped.get(targetIndex);
        if (cached) {
            this.skipped.delete(targetIndex);
            return cached;
        }

        if (targetIndex < this.index) {
            throw new Error(`message key for index ${targetIndex} is already consumed and was not retained`);
        }

        if (targetIndex - this.index > MAX_SKIP) {
            throw new Error(`refusing to skip ${targetIndex - this.index} messages (limit ${MAX_SKIP})`);
        }

        // Walk forward, retaining the keys we step over so those messages can still arrive later.
        while (this.index < targetIndex) {
            this.skipped.set(this.index, deriveMessageKey(this.chainKey));
            this.chainKey = advanceChain(this.chainKey);
            this.index += 1;
        }

        const derived = deriveMessageKey(this.chainKey);
        this.chainKey = advanceChain(this.chainKey);
        this.index += 1;

        return derived;
    }
}
