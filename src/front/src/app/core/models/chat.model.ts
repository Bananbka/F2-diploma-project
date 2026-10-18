import { MessageResponse } from './crypto.model';

export type ChatType = 'private' | 'group' | 'channel';
export type ParticipantRole = 'owner' | 'admin' | 'member';

export interface ChatParticipant {
    user_id: string;
    role: ParticipantRole;
    joined_at: string;
}

/**
 * One participant's read high-water mark for a chat, from `GET /chats/{id}/read-state`.
 *
 * Deliberately per-user rather than a chat-level value: `MessageDocument.is_read` is one shared
 * boolean per message, so one member reading a group message used to mark it read for everyone.
 * `last_read_message_id` is a canonical (lowercase, 24-hex-char) Mongo ObjectId string, or `null`
 * if this participant has never marked anything read — safe to compare directly against a
 * message's own `_id` with plain string `>=`.
 */
export interface ParticipantReadState {
    user_id: string;
    last_read_message_id: string | null;
}

export interface Chat {
    id: string;
    chat_type: ChatType;
    title: string | null;
    avatar_url: string | null;
    unread_count: number;
    /**
     * The full raw message document, opaque under E2E — the client must decrypt it to render a
     * preview, and can only do so for chats whose sender chains it already holds.
     */
    last_message: MessageResponse | null;
    created_at: string;
    updated_at: string | null;
    /**
     * Empty on `GET /chats/`: `enrich_chats_with_mongo_data` returns plain dicts with no
     * participants key and Pydantic falls back to the default. Only `GET /chats/{id}` populates it.
     */
    participants: ChatParticipant[];
    /**
     * Per-user mute state for the calling user only — never a property of the chat itself, and
     * never broadcast over the socket. `is_muted` is a computed field the server derives from
     * `muted_until` against the current time, so the client does not need to compare it to `now`
     * itself (and would otherwise disagree with the server near the expiry instant).
     */
    muted_until: string | null;
    is_muted: boolean;
}

export interface UserProfile {
    id: string;
    full_name: string;
    username: string;
    email: string;
    phone_number: string;
    public_key: string;
    bio: string | null;
    avatar: string | null;
    is_active: boolean;
}

export interface UserSearchResult {
    id: string;
    full_name: string;
    username: string;
    avatar_url: string | null;
}

export interface Contact {
    owner_id: string;
    contact_id: string;
    alias_name: string | null;
    user: UserSearchResult;
}

/**
 * `POST/GET /chats/{id}/invite-links`. `is_active` is a computed field the server derives from
 * `revoked_at`/`expires_at`/`max_uses` vs `use_count` — mirrored here as a plain boolean rather
 * than re-derived client-side, so this can never disagree with the server about whether a link
 * near its expiry or use cap is still usable.
 */
export interface InviteLink {
    id: string;
    chat_id: string;
    token: string;
    created_by: string | null;
    created_at: string;
    expires_at: string | null;
    max_uses: number | null;
    use_count: number;
    revoked_at: string | null;
    is_active: boolean;
}

/**
 * `GET /invite-links/{token}`. Deliberately narrow — title, avatar, chat type and a member
 * *count*, never the roster — so previewing a link never discloses more than deciding whether to
 * join requires.
 */
export interface InviteLinkPreview {
    chat_id: string;
    chat_type: ChatType;
    title: string | null;
    avatar_url: string | null;
    member_count: number;
}

/** `POST /invite-links/join`. `already_member` is a clean no-op signal, not an error. */
export interface InviteLinkJoinResult {
    chat_id: string;
    already_member: boolean;
}
