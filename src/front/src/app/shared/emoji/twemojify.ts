import twemoji from '@twemoji/api';

/**
 * Where the self-hosted Twemoji SVGs live — copied from the `@twemoji/svg` npm package by
 * `scripts/copy-emoji.mjs` into `public/assets/emoji/`, served same-origin so the CSP's
 * `img-src 'self' data: blob:` needs no change. Never point this at a CDN: see the CSP
 * rationale at the top of `security-headers.conf`.
 */
const EMOJI_BASE_PATH = '/assets/emoji/';

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** Escapes the five HTML-significant characters. Safe to call on any string, emoji or not. */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Turns plain text into HTML markup where every emoji is a self-hosted Twemoji `<img>`, safe to
 * bind via `[innerHTML]` once passed through `DomSanitizer.sanitize(SecurityContext.HTML, ...)`.
 *
 * This app is end-to-end encrypted, so decrypted message text is attacker-controlled: it is
 * HTML-escaped FIRST, and only the escaped string is ever handed to the emoji replacer. Emoji
 * code points cannot collide with the escaped entities (`&amp;`, `&lt;`, ...), so escaping first
 * never hides or breaks emoji detection, and it guarantees any literal `<`, `>`, `&`, `"` or `'`
 * the sender typed is already inert before Twemoji — or anything else — ever touches the string.
 *
 * This function alone is not the security boundary: callers still MUST run the result through
 * Angular's `DomSanitizer.sanitize(SecurityContext.HTML, ...)` before binding it, never
 * `bypassSecurityTrustHtml`, which would skip Angular's own stripping of anything that
 * nonetheless made it through. `TwemojiPipe` does exactly that and is the preferred way to use
 * this in a template.
 */
export function twemojifyHtml(text: string): string {
    const escaped = escapeHtml(text);
    return twemoji.parse(escaped, {
        className: 'twemoji',
        callback: (icon: string): string => `${EMOJI_BASE_PATH}${icon}.svg`,
    });
}
