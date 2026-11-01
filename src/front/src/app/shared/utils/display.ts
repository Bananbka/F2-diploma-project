/** What a deleted account is called everywhere; mirrors the server's tombstone `full_name`. */
export const DELETED_USER_LABEL = 'Deleted user';

/** The name a chat goes by in lists and pickers. */
export function chatTitle(chat: { chat_type: string; title: string | null; peer_is_deleted?: boolean }): string {
    if (chat.chat_type === 'private' && chat.peer_is_deleted) {
        return DELETED_USER_LABEL;
    }
    return chat.title?.trim() || (chat.chat_type === 'channel' ? 'Channel' : 'Untitled chat');
}

const SEGMENTER =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;

/** The user-perceived characters of `text`, so an emoji or a combining sequence is never cut in half. */
function graphemes(text: string): string[] {
    return SEGMENTER ? Array.from(SEGMENTER.segment(text), (part) => part.segment) : Array.from(text);
}

/** Upper-case one character and keep one: `ß` becomes `SS`, and a monogram wants the `S` only. */
function capital(grapheme: string): string {
    return graphemes(grapheme.toUpperCase())[0] ?? '';
}

/** Two-letter monogram, matching the design's avatar treatment. */
export function initials(name: string): string {
    const parts = name.trim().replace(/^[#@]/, '').split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
        return '??';
    }
    if (parts.length === 1) {
        return graphemes(parts[0]).slice(0, 2).map(capital).join('');
    }
    return capital(graphemes(parts[0])[0]) + capital(graphemes(parts[parts.length - 1])[0]);
}

/** Which avatar treatment a chat gets: the peer's own face for a private chat, a group monogram otherwise. */
export function avatarKindFor(chatType: string | null | undefined): 'person' | 'group' | 'channel' {
    return chatType === 'group' ? 'group' : chatType === 'channel' ? 'channel' : 'person';
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Monogram for a group or channel title: the first letter of up to two words.
 *
 * Decoration such as a leading `#`, punctuation and emoji is skipped so `#general` reads as `G` and
 * `🎮 Game night` as `GN`, never as a symbol. A title with no letters at all but with an emoji
 * yields that emoji; one with neither yields an empty string, which the avatar renders as an icon.
 */
export function groupInitials(name: string): string {
    const words = name.split(/\s+/).filter(Boolean);
    const letters: string[] = [];
    for (const word of words) {
        const start = Array.from(word).findIndex((char) => LETTER_OR_DIGIT.test(char));
        if (start >= 0) {
            letters.push(capital(graphemes(Array.from(word).slice(start).join(''))[0]));
        }
        if (letters.length === 2) {
            break;
        }
    }
    if (letters.length > 0) {
        return letters.join('');
    }
    const emoji = words.find((word) => /\p{Extended_Pictographic}/u.test(word));
    return emoji ? (graphemes(emoji)[0] ?? '') : '';
}

/**
 * A stable avatar colour.
 *
 * Derived from the identifier rather than assigned from a rotating counter, so the same person keeps
 * the same colour across sessions and reorderings of the chat list.
 */
const AVATAR_COLORS = [
    '#7c3aed',
    '#1d4ed8',
    '#0f766e',
    '#059669',
    '#b91c1c',
    '#0369a1',
    '#92400e',
    '#1e3a5f',
    '#6d28d9',
    '#be185d',
];

export function avatarColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Clock time for a message row. */
export function messageTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Relative-ish stamp for a chat list row: time today, weekday this week, date beyond. */
export function chatListTime(iso: string | null): string {
    if (!iso) {
        return '';
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) {
        return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
    }

    const withinWeek = now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000;
    return withinWeek
        ? date.toLocaleDateString(undefined, { weekday: 'short' })
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Split a 60-digit safety number into the design's twelve groups of five. */
export function safetyNumberGroups(value: string): string[] {
    const digits = value.replace(/\D/g, '');
    const groups: string[] = [];
    for (let i = 0; i + 5 <= digits.length; i += 5) {
        groups.push(digits.slice(i, i + 5));
    }
    return groups;
}
