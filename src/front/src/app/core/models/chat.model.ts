import { MessageResponse } from './crypto.model';

export type ChatType = 'private' | 'group' | 'channel';
export type ParticipantRole = 'owner' | 'admin' | 'member';

export interface ChatParticipant {
    user_id: string;
    role: ParticipantRole;
    joined_at: string;
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
