import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { b64uDecode, b64uEncode, concatBytes, DS_CHANNEL_POST, utf8, uuidBytes } from './primitives';

/**
 * Channel posts: signed, not encrypted. Client half of `reference/channel.py`.
 *
 * Channels sit outside the end-to-end trust boundary deliberately. Confidentiality is meaningless
 * for open broadcast — any adversary simply subscribes — and sender-key distribution costs O(N)
 * per rotation on a single client, which stops converging well before channel scale.
 *
 * Integrity is not meaningless, and costs one signature per post regardless of subscriber count.
 * Subscribers MUST verify: it is the only guarantee that a post really came from the channel
 * owner rather than being fabricated by the server.
 */

export const ALGORITHM = 'ed25519-post-v1';

export interface ChannelPost {
    v: number;
    alg: string;
    post_id: string;
    content: string;
    sig: string;
}

/**
 * chatId and senderId stop a post being relocated or reattributed; postId makes each signature
 * unique so a captured (content, signature) pair cannot be replayed as a second post.
 */
export function channelPostPayload(chatId: string, senderId: string, postId: string, content: string): Uint8Array {
    return concatBytes(
        DS_CHANNEL_POST,
        uuidBytes(chatId),
        uuidBytes(senderId),
        uuidBytes(postId),
        sha256(utf8(content))
    );
}

export function signChannelPost(params: {
    signingPrivate: Uint8Array;
    chatId: string;
    senderId: string;
    postId: string;
    content: string;
}): string {
    return b64uEncode(
        ed25519.sign(
            channelPostPayload(params.chatId, params.senderId, params.postId, params.content),
            params.signingPrivate
        )
    );
}

export function verifyChannelPost(params: {
    signingPublic: Uint8Array;
    signature: string;
    chatId: string;
    senderId: string;
    postId: string;
    content: string;
}): boolean {
    try {
        return ed25519.verify(
            b64uDecode(params.signature),
            channelPostPayload(params.chatId, params.senderId, params.postId, params.content),
            params.signingPublic
        );
    } catch {
        return false;
    }
}
