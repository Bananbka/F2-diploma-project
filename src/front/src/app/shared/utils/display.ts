/** Two-letter monogram, matching the design's avatar treatment. */
export function initials(name: string): string {
    const parts = name.trim().replace(/^[#@]/, '').split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
        return '??';
    }
    if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
