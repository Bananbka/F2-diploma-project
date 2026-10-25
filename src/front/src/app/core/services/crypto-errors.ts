import { HttpErrorResponse } from '@angular/common/http';

/**
 * The roster could not be trusted, so no key was handed to it.
 *
 * A class rather than a message prefix. This was matched with
 * `error.message.startsWith('Member set verification failed')`, and the moment a second kind of
 * failure was added — a binding signature that does not verify, which is the *stronger* signal —
 * its message began differently, the match silently stopped firing, and the single most
 * important refusal in the app degraded into an ordinary "send failed". A type cannot drift out
 * of sync with the thing that throws it.
 */
export class RosterVerificationError extends Error {
    /** Which refusal this is. A binding-signature failure is the stronger signal of the two. */
    readonly code: RosterFailureCode = 'ROSTER_VERIFICATION_FAILED';

    constructor(message: string) {
        super(message);
        this.name = 'RosterVerificationError';
    }
}

/** The roster disagrees with the member-set commitment stored on the epoch. */
export class MemberSetMismatchError extends RosterVerificationError {
    override readonly code: RosterFailureCode = 'MEMBER_SET_MISMATCH';

    constructor(message: string) {
        super(message);
        this.name = 'MemberSetMismatchError';
    }
}

/** Typed client error names from the delivery algorithm (docs/event-queue-plan.md, TB-30). */
export type RosterFailureCode = 'ROSTER_VERIFICATION_FAILED' | 'MEMBER_SET_MISMATCH';
export type ClientErrorCode = RosterFailureCode | 'RETRY_LIMIT_EXCEEDED';

/**
 * Publishing the sender key kept failing for reasons that may well be transient, and the retry
 * budget is spent. Distinct from a roster refusal: nothing is suspicious, the send simply did not
 * go through, so it ends as an ordinary retryable "not sent" rather than a security alarm.
 */
export class RetryLimitExceededError extends Error {
    readonly code: ClientErrorCode = 'RETRY_LIMIT_EXCEEDED';

    constructor(
        readonly attempts: number,
        readonly lastError: unknown
    ) {
        super(`Could not publish the sender key after ${attempts} attempts.`);
        this.name = 'RetryLimitExceededError';
    }
}

export function isRetryLimitExceeded(error: unknown): error is RetryLimitExceededError {
    return error instanceof RetryLimitExceededError;
}

/** Sending must be blocked outright: we refused to distribute keys to an unverifiable roster. */
export function isRosterVerificationFailure(error: unknown): error is RosterVerificationError {
    return error instanceof RosterVerificationError;
}

/**
 * Failures worth another attempt at publishing a sender key: no response at all, a server fault,
 * the epoch closing under us, or the member set moving between the roster read and the upload.
 * Everything else (a 4xx that says "no", or a roster refusal) will not change by asking again.
 */
export function isRetryablePublishError(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse)) {
        return false;
    }
    if (error.status === 0 || error.status >= 500) {
        return true;
    }
    const code = errorCode(error);
    return code === 'EPOCH_CLOSED' || code === 'GRANT_SET_MISMATCH';
}

/** The error code carried by an `HttpErrorResponse` body, if any. */
export function httpErrorCode(error: unknown): string | null {
    return errorCode(error);
}

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
