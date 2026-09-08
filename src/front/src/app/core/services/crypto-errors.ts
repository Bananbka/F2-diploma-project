import { HttpErrorResponse } from '@angular/common/http';

function errorCode(error: unknown): string | null {
    if (!(error instanceof HttpErrorResponse)) {
        return null;
    }
    const code = (error.error as { error_code?: unknown } | null)?.error_code;
    return typeof code === 'string' ? code : null;
}

/**
 * The chat has no `ChatCryptoSettings` row.
 *
 * Expected rather than exceptional. Nothing creates that row implicitly — `POST /chats/private` and
 * `POST /chats/group` both leave it absent until `POST /crypto/chats/{id}/enable` is called — and a
 * channel can never have one, since channels are signed instead of encrypted.
 */
export function isCryptoNotEnabled(error: unknown): boolean {
    return errorCode(error) === 'CRYPTO_NOT_ENABLED';
}

/** Someone else enabled encryption first. Benign: the desired state now holds either way. */
export function isAlreadyEnabled(error: unknown): boolean {
    return errorCode(error) === 'ALREADY_ENABLED';
}

/**
 * Encryption cannot be turned on for this chat at all — too many members, or a channel.
 * Distinct from a transport failure, because retrying will never help.
 */
export function isEncryptionRefused(error: unknown): string | null {
    const code = errorCode(error);
    if (code !== 'GROUP_TOO_LARGE' && code !== 'CHANNEL_NOT_SUPPORTED') {
        return null;
    }

    const message = (error as HttpErrorResponse).error?.message;
    return typeof message === 'string' ? message : 'Encryption cannot be enabled for this chat.';
}

/**
 * We may not enable encryption here — a group whose owner has not turned it on.
 *
 * Worth its own state rather than a generic failure: nothing is broken and the user has nothing to
 * fix. Reporting it as an error would make an ordinary permission boundary look like a fault.
 */
export function isEnableForbidden(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status === 403 && errorCode(error) === 'ACCESS_DENIED';
}
