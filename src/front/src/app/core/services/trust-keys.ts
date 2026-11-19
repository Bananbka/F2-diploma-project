/**
 * The key every per-pair trust structure is stored under: `<own user id>:<peer user id>`.
 *
 * Null when either id is empty: such a key would put unrelated pairs in one shared bucket.
 */
export function pairKey(selfId: string, peerId: string): string | null {
    return selfId && peerId ? `${selfId}:${peerId}` : null;
}

/**
 * A safety number reduced to its digits, so formatting (spaces, line breaks, grouping) never reads
 * as a different number. Every comparison of two safety numbers goes through this.
 */
export function safetyDigits(value: string): string {
    return value.replace(/\D/g, '');
}
