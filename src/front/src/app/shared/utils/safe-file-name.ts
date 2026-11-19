/**
 * An attachment's name as it is safe to show and to save under.
 *
 * `Attachment.name` is plain server-side metadata: it is not inside the sealed payload, so under the
 * threat model it is whatever the server says. Shown and saved verbatim, it can lie about what a
 * file is: a right-to-left override (U+202E) makes `invoice[RLO]fdp.exe` read as `invoiceexe.pdf`, a
 * control character hides or splits the name, and a path separator suggests a location. None of that
 * is needed by an honest name, so it is removed rather than escaped:
 *
 * - C0/C1 control characters, DEL, and the line/paragraph separators;
 * - bidirectional formatting characters (marks, embeddings, overrides, isolates);
 * - `/` and `\`, replaced with `_` so the name stays one path segment;
 * - leading dots and whitespace, trailing dots and whitespace.
 *
 * This is presentation hygiene, not authentication: the name is still the server's claim. Sealing
 * the metadata with the message is a wire-format change, noted in `docs/tech-debt.md` section 14.
 */

const FALLBACK = 'attachment';
const MAX_LENGTH = 200;

// C0, DEL and C1 controls; U+2028/U+2029 separators; a BOM.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g;
// ALM, LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const SEPARATOR = /[\\/]/g;

export function safeFileName(name: unknown): string {
    if (typeof name !== 'string') {
        return FALLBACK;
    }
    const cleaned = name
        .replace(CONTROL, '')
        .replace(BIDI, '')
        .replace(SEPARATOR, '_')
        .replace(/^[.\s]+/, '')
        .replace(/[.\s]+$/, '');

    if (!cleaned) {
        return FALLBACK;
    }
    return cleaned.length > MAX_LENGTH ? truncateKeepingExtension(cleaned) : cleaned;
}

/** Cut the stem, not the extension: the OS decides what a file is from the end of its name. */
function truncateKeepingExtension(name: string): string {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    return name.slice(0, MAX_LENGTH - extension.length) + extension;
}
