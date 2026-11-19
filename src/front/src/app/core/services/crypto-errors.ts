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

/**
 * The roster (or the chat itself) names people this client does not accept as the chat's members:
 * a user id outside the chat, a different counterpart for a private chat than the one pinned when it
 * was first opened, a private chat now reported as some other type, or a roster that leaves us out.
 * Every key in it may be perfectly self-consistent; the refusal is about *who*, not *which key*.
 */
export class MembershipMismatchError extends RosterVerificationError {
    override readonly code: RosterFailureCode = 'MEMBERSHIP_MISMATCH';

    constructor(message: string) {
        super(message);
        this.name = 'MembershipMismatchError';
    }
}

/**
 * The roster lists a device under *our own* user id that neither our device list at unlock nor a
 * fresh `GET /crypto/identity/me` contains. Raised whatever anyone's verification state: a device
 * under our id would read every message we send in every chat, and no peer's safety number is
 * guaranteed to catch it (an unverified peer's never does).
 */
export class UnknownOwnDeviceError extends RosterVerificationError {
    override readonly code: RosterFailureCode = 'OWN_DEVICE_UNKNOWN';

    constructor(message: string) {
        super(message);
        this.name = 'UnknownOwnDeviceError';
    }
}

/** Typed client error names from the delivery algorithm (docs/event-queue-plan.md, TB-30). */
export type RosterFailureCode =
    'ROSTER_VERIFICATION_FAILED' | 'MEMBER_SET_MISMATCH' | 'MEMBERSHIP_MISMATCH' | 'OWN_DEVICE_UNKNOWN';
export type ClientErrorCode = RosterFailureCode | 'RETRY_LIMIT_EXCEEDED' | 'KEY_CHANGED' | 'MEMBERSHIP_UNCONFIRMED';

/**
 * Nothing is known to be wrong, but this client cannot yet say who the chat's members are — the
 * private chat's participant list is missing or does not have the shape {me, one peer}, and no
 * counterpart has been pinned for it. No key was distributed. Not a roster alarm (the server has not
 * been caught lying); an honest, retryable "not sent" with its own wording (docs/ui-states.md).
 */
export class MembershipUnconfirmedError extends Error {
    readonly code: ClientErrorCode = 'MEMBERSHIP_UNCONFIRMED';

    constructor(message = 'The members of this chat could not be confirmed, so no key was distributed.') {
        super(message);
        this.name = 'MembershipUnconfirmedError';
    }
}

export function isMembershipUnconfirmed(error: unknown): error is MembershipUnconfirmedError {
    return error instanceof MembershipUnconfirmedError;
}

/** One member whose safety number no longer matches the one the user confirmed out of band. */
export interface KeyChangedPeer {
    userId: string;
    /** The number derived from the keys the roster presents now. */
    current: string;
    /** The number the user verified, as remembered by `TrustStoreService`. */
    previous: string;
}

/**
 * A *verified* peer's key changed, so no chain key was wrapped for the roster.
 *
 * A sibling of `RosterVerificationError`, deliberately not a subclass: the roster passed both of
 * §5.0.2's checks — every entry is self-consistent and matches the epoch commitment — but a
 * self-consistent roster is exactly what a server substituting a whole device produces. The one
 * thing it cannot forge is the safety number the user already compared with that person, so this
 * is the state where that comparison pays off. Blocking, never retried: only the user re-confirming
 * the new number in the safety-number screen can clear it.
 */
export class KeyChangedError extends Error {
    readonly code: ClientErrorCode = 'KEY_CHANGED';

    /**
     * @param ownDevicesChanged The roster lists keys under *our own* user id that our own device
     *   list (`GET /crypto/identity/me`) does not. A safety number covers both sides, so a device
     *   added under our id changes the number with every verified peer at once — and blaming each
     *   of those peers for it would point the user at the wrong person entirely.
     */
    constructor(
        readonly chatId: string,
        readonly peers: readonly KeyChangedPeer[],
        readonly ownDevicesChanged = false
    ) {
        super(
            ownDevicesChanged
                ? 'Your own device list changed, which changes the safety number with every verified member. ' +
                      'Refusing to distribute keys until the new safety numbers are confirmed.'
                : `The security key of ${peers.length === 1 ? 'a verified member' : `${peers.length} verified members`} ` +
                      'changed. Refusing to distribute keys until the new safety number is confirmed.'
        );
        this.name = 'KeyChangedError';
    }
}

/** Sending must be blocked until the user reviews the changed safety number. */
export function isKeyChanged(error: unknown): error is KeyChangedError {
    return error instanceof KeyChangedError;
}

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

/**
 * What the user has confirmed changed while a sender chain was being wrapped and published — here or
 * in another tab. The roster was checked against the old confirmations, so the chain is not used:
 * not an alarm, just a publish to redo from a fresh roster read (`isRetryablePublishError`).
 */
export class TrustChangedDuringPublishError extends Error {
    constructor() {
        super('Your verified safety numbers changed while the key was being published; re-checking.');
        this.name = 'TrustChangedDuringPublishError';
    }
}

/** Sending must be blocked outright: we refused to distribute keys to an unverifiable roster. */
export function isRosterVerificationFailure(error: unknown): error is RosterVerificationError {
    return error instanceof RosterVerificationError;
}

/**
 * Failures worth another attempt at publishing a sender key: no response at all, a server fault,
 * the epoch closing under us, the member set moving between the roster read and the upload, or the
 * user's confirmed safety numbers changing while the chain was being wrapped.
 * Everything else (a 4xx that says "no", or a roster refusal) will not change by asking again.
 */
export function isRetryablePublishError(error: unknown): boolean {
    if (error instanceof TrustChangedDuringPublishError) {
        return true;
    }
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
