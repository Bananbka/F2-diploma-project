import { MessageEnvelope } from '../crypto/envelope';

export type CryptoMode = 'legacy' | 'sender_keys_v1' | 'not_encrypted';
export type HistoryVisibility = 'joined' | 'shared';

export type ContentFormat = 'legacy_plaintext' | 'legacy_rsa' | 'sender_keys_v1' | 'channel_signed_v1';

export interface PublicKey {
    user_id: string;
    device_id: string;
    identity_key_id: string;
    version: number;
    identity_public_key: string;
    signing_public_key: string;
    identity_key_signature: string;
    signed_prekey_public: string | null;
    signed_prekey_signature: string | null;
}

export interface OwnIdentity extends PublicKey {
    encrypted_private_bundle: string;
    kdf_params: { kdf: string; m: number; t: number; p: number; salt: string; nonce: string };
    created_at: string;
    /** Owner-only: when this device's prekey was minted, so the client knows when to rotate it. */
    signed_prekey_created_at: string | null;
}

export interface RosterEntry {
    user_id: string;
    device_id: string;
    identity_key_id: string;
    identity_public_key: string;
    signing_public_key: string;
    signed_prekey_public: string | null;
}

export interface ChatRoster {
    chat_id: string;
    current_epoch: number;
    /** Clients MUST recompute this from `members` and refuse to wrap keys on mismatch. */
    member_set_hash: string;
    members: RosterEntry[];
}

export interface KeyEpoch {
    id: string;
    epoch: number;
    reason: string;
    member_count: number;
    member_set_hash: string;
    created_at: string;
    closed_at: string | null;
}

export interface GrantPayload {
    recipient_device_id: string;
    recipient_identity_key_id: string;
    wrap_algorithm: string;
    ephemeral_public_key: string;
    wrapped_chain_key: string;
}

export interface Distribution {
    distribution_id: string;
    epoch: number;
    sender_user_id: string;
    sender_device_id: string;
    sender_key_id: string;
    algorithm: string;
    signing_public_key: string;
    chain_start_index: number;
    signature: string;
    /** null means this sender has not wrapped for our device yet — ask, don't give up. */
    grant: GrantPayload | null;
}

export interface ChatKeys {
    crypto_mode: CryptoMode;
    history_visibility: HistoryVisibility;
    current_epoch: number;
    my_join_epoch: number | null;
    epochs: KeyEpoch[];
    distributions: Distribution[];
}

export interface GrantUpload {
    recipient_device_id: string;
    wrap_algorithm: string;
    ephemeral_public_key: string;
    wrapped_chain_key: string;
}

export interface SenderKeyUpload {
    sender_device_id: string;
    sender_key_id: string;
    algorithm: string;
    signing_public_key: string;
    chain_start_index: number;
    signature: string;
    grants: GrantUpload[];
}

export interface IdentityPublishRequest {
    device_id: string;
    display_name: string;
    identity_public_key: string;
    signing_public_key: string;
    identity_key_signature: string;
    signed_prekey_public?: string | null;
    signed_prekey_signature?: string | null;
    encrypted_private_bundle: string;
    kdf_params: Record<string, unknown>;
}

export interface ChannelPostPayload {
    v: number;
    alg: string;
    post_id: string;
    content: string;
    sig: string;
}

/**
 * An uploaded file referenced by a message.
 *
 * The bytes are encrypted by the client before upload — the server stores an opaque blob and the
 * `content_type` describes the original, not what is stored.
 */
export interface MessageAttachment {
    url: string;
    name: string;
    size: number;
    content_type: string;
}

/**
 * Who wrote a forwarded message originally.
 *
 * The server stores this verbatim and cannot verify it: a forward under E2E is a re-send, sealed and
 * signed by the forwarder. It is attribution, not attestation.
 */
export interface ForwardOrigin {
    user_id: string;
    created_at: string;
}

export interface MessageResponse {
    _id: string;
    chat_id: string;
    sender_id: string;
    encrypted_content: string | null;
    envelope: MessageEnvelope | null;
    channel_post: ChannelPostPayload | null;
    content_format: ContentFormat;
    reply_to_message_id: string | null;
    forwarded_from: ForwardOrigin | null;
    created_at: string;
    attachments: MessageAttachment[] | null;
    is_read: boolean;
    is_pinned: boolean;
    is_edited: boolean;
    is_encrypted: boolean;
}
