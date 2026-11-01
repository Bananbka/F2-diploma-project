import { Chat } from '../models/chat.model';

/**
 * Combine the chat-list row with `GET /chats/{id}`.
 *
 * The two endpoints hold complementary halves. The list is enriched (resolved counterpart title and
 * avatar, unread count, last message, per-user mute, deleted-peer flag) but has no participants; the
 * detail has participants but NULL for every list-only field of a private chat. So the list wins
 * wherever it has a value, and the detail contributes what the list cannot: the roster, and fallbacks
 * for fields the list lacks. Taking the detail as the base and overriding only a few fields blanked the
 * counterpart's avatar the moment a chat was opened. Mute and `updated_at` are the exception: the
 * detail is the fresher source for those (and `updated_at` takes whichever is newer).
 */
function newerOf(a: string | null, b: string | null): string | null {
    if (a === null || b === null) {
        return a ?? b;
    }
    return Date.parse(b) >= Date.parse(a) ? b : a;
}

export function mergeChatDetail(list: Chat | undefined, detail: Chat): Chat {
    if (!list) {
        return detail;
    }

    return {
        ...detail,
        title: list.title ?? detail.title,
        avatar_url: list.avatar_url ?? detail.avatar_url,
        unread_count: list.unread_count,
        last_message: list.last_message ?? detail.last_message,
        updated_at: newerOf(list.updated_at, detail.updated_at),
        // Mute is per-user server state the detail reports directly; the list copy can be older.
        muted_until: detail.muted_until !== undefined ? detail.muted_until : list.muted_until,
        is_muted: detail.is_muted ?? list.is_muted,
        peer_is_deleted: list.peer_is_deleted ?? detail.peer_is_deleted,
        // Pin and manual-unread are mutated optimistically and by realtime echoes, both of which land
        // on the list copy. The detail is a snapshot from an earlier request and can be older.
        is_pinned: list.is_pinned ?? detail.is_pinned,
        pinned_at: list.pinned_at !== undefined ? list.pinned_at : detail.pinned_at,
        marked_unread: list.marked_unread ?? detail.marked_unread,
        my_role: list.my_role ?? detail.my_role,
        participants: detail.participants.length > 0 ? detail.participants : list.participants,
    };
}
