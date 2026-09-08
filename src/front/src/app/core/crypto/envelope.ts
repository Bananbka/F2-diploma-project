import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { b64uDecode, b64uEncode, concatBytes, DS_MESSAGE, u32be, uuidBytes, VERSION } from './primitives';

/**
 * Message envelope: seal, open, verify. Client half of `reference/envelope.py`.
 *
 *     msg_aad = "NS-v1-msg" || chat_id(16) || u32be(epoch) || sender_id(16)
 *                           || sender_key_id(16) || u32be(chain_index)     = 65 bytes
 *
 *     ct  = AES-256-GCM(MK_i, N_i, plaintext, aad=msg_aad)
 *     sig = Ed25519(chain_signing_key, msg_aad || SHA-256(ct))
 *
 * The AAD is what stops a ciphertext being relocated to another chat, reattributed to another
 * sender, or replayed into a later epoch. `chatId` and `senderId` must come from trusted state —
 * the route being viewed and the authenticated session — never from the envelope itself, or the
 * binding proves nothing.
 */

export const ALGORITHM = 'A256GCM-SK1';

export interface MessageEnvelope {
    v: number;
    alg: string;
    epoch: number;
    skid: string;
    idx: number;
    n: string;
    ct: string;
    sig: string;
}

export function buildMessageAad(
    chatId: string,
    epoch: number,
    senderId: string,
    senderKeyId: string,
    chainIndex: number
): Uint8Array {
    return concatBytes(
        DS_MESSAGE,
        uuidBytes(chatId),
        u32be(epoch),
        uuidBytes(senderId),
        uuidBytes(senderKeyId),
        u32be(chainIndex)
    );
}

/** Signing SHA-256(ct) rather than ct keeps signature cost flat for large attachments. */
function signaturePayload(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    return concatBytes(aad, sha256(ciphertext));
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface SealParams {
    messageKey: Uint8Array;
    nonce: Uint8Array;
    signingPrivate: Uint8Array;
    chatId: string;
    epoch: number;
    senderId: string;
    senderKeyId: string;
    chainIndex: number;
    plaintext: Uint8Array;
}

export async function sealMessage(params: SealParams): Promise<MessageEnvelope> {
    const aad = buildMessageAad(params.chatId, params.epoch, params.senderId, params.senderKeyId, params.chainIndex);

    const key = await importAesKey(params.messageKey);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: params.nonce as BufferSource, additionalData: aad as BufferSource },
            key,
            params.plaintext as BufferSource
        )
    );

    const signature = ed25519.sign(signaturePayload(aad, ciphertext), params.signingPrivate);

    return {
        v: VERSION,
        alg: ALGORITHM,
        epoch: params.epoch,
        skid: params.senderKeyId,
        idx: params.chainIndex,
        n: b64uEncode(params.nonce),
        ct: b64uEncode(ciphertext),
        sig: b64uEncode(signature),
    };
}

export function verifyEnvelopeSignature(
    envelope: MessageEnvelope,
    signingPublic: Uint8Array,
    chatId: string,
    senderId: string
): boolean {
    try {
        const aad = buildMessageAad(chatId, envelope.epoch, senderId, envelope.skid, envelope.idx);
        return ed25519.verify(b64uDecode(envelope.sig), signaturePayload(aad, b64uDecode(envelope.ct)), signingPublic);
    } catch {
        return false;
    }
}

export interface OpenParams {
    messageKey: Uint8Array;
    envelope: MessageEnvelope;
    chatId: string;
    senderId: string;
    signingPublic?: Uint8Array;
}

/**
 * Verify and decrypt. Signature verification happens BEFORE decryption when a key is supplied: a
 * client must never act on a message whose sender it has not authenticated.
 */
export async function openMessage(params: OpenParams): Promise<Uint8Array> {
    const { envelope, chatId, senderId } = params;

    if (params.signingPublic && !verifyEnvelopeSignature(envelope, params.signingPublic, chatId, senderId)) {
        throw new Error('envelope signature does not verify');
    }

    const aad = buildMessageAad(chatId, envelope.epoch, senderId, envelope.skid, envelope.idx);
    const key = await importAesKey(params.messageKey);

    // A mismatch in any bound field surfaces here as a GCM tag failure.
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64uDecode(envelope.n) as BufferSource, additionalData: aad as BufferSource },
        key,
        b64uDecode(envelope.ct) as BufferSource
    );

    return new Uint8Array(plaintext);
}
