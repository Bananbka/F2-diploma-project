/**
 * Typed plaintext payloads carried inside a sealed message envelope.
 *
 * The envelope, ratchet and signature are untouched: this is only the structure of the plaintext
 * under the seal (docs/crypto-spec-v1.md, section 4.6). A plain text message keeps the original
 * `{text, attachmentKeys}` shape. A typed payload adds `v` and `type` plus one body object, and
 * still carries a human-readable `text` fallback so an older client shows something sensible.
 *
 * Everything here is pure and validates in both directions: `build*` refuses to produce a payload a
 * receiver would reject, and `classifyPlaintext` refuses to trust anything it was handed.
 */

export const PAYLOAD_VERSION = 1;

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 10;
export const LOCATION_LABEL_MAX = 100;
/** Generous but finite: no handset reports an accuracy radius beyond Earth's circumference. */
export const LOCATION_ACCURACY_MAX = 40_000_000;

const OBJECT_ID = /^[0-9a-f]{24}$/;

/**
 * What an anonymous poll can honestly promise. Shown next to the "Anonymous" label in the dialog
 * and on the card; the same words are in docs/crypto-spec-v1.md section 4.7.
 */
export const ANONYMOUS_POLL_NOTE =
    "Anonymous only in the interface: the server knows who voted, and other members' browsers can see it too. This app merely hides it.";

/** Decimal places kept for coordinates (about 0.1 m): enough for a map pin, no float noise. */
export const COORDINATE_DECIMALS = 6;

function roundCoordinate(value: number): number {
    // toFixed never uses exponent notation below 1e21, and rounds away the float noise a device adds.
    return Number(value.toFixed(COORDINATE_DECIMALS));
}

export interface PollPayload {
    question: string;
    options: string[];
    /** Several options may be chosen. */
    multiple: boolean;
    /** Interface-level only: hides who voted for what. See docs/tech-debt.md. */
    anonymous: boolean;
    /** ISO-8601; votes cast after this instant are ignored. */
    closesAt: string | null;
}

export interface PollVotePayload {
    pollId: string;
    /** Distinct zero-based option indices. */
    options: number[];
}

export interface PollClosePayload {
    pollId: string;
}

export interface LocationPayload {
    lat: number;
    lon: number;
    accuracy: number | null;
    label: string | null;
}

/** Why a payload could not be shown as the thing it claims to be. */
export type UnsupportedReason =
    /** A `type` this version does not know. */
    | 'unknown_type'
    /** A `v` newer than this version understands. */
    | 'newer_version'
    /** A known type whose body failed validation. */
    | 'malformed'
    /** A vote/close sent as an ordinary message, or an ordinary payload sent as a control message. */
    | 'misplaced';

export type MessageContent =
    | { kind: 'text' }
    | { kind: 'poll'; poll: PollPayload }
    | { kind: 'poll_vote'; vote: PollVotePayload }
    | { kind: 'poll_close'; close: PollClosePayload }
    | { kind: 'location'; location: LocationPayload }
    | { kind: 'unsupported'; reason: UnsupportedReason; type: string | null };

/** The payload kinds a sender may put in a message. Text is the default and needs no payload. */
export type TypedContent = Exclude<MessageContent, { kind: 'text' } | { kind: 'unsupported' }>;

export const TEXT_CONTENT: MessageContent = { kind: 'text' };

export function isControlContent(content: MessageContent): boolean {
    return content.kind === 'poll_vote' || content.kind === 'poll_close';
}

export class PayloadValidationError extends Error {}

// ---------------------------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function isObjectId(value: unknown): value is string {
    return typeof value === 'string' && OBJECT_ID.test(value);
}

export function isValidLatitude(value: unknown): value is number {
    return isFiniteNumber(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
    return isFiniteNumber(value) && value >= -180 && value <= 180;
}

function isIsoDate(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------------------------
// Validation of the bodies (shared by send and receive)
// ---------------------------------------------------------------------------------------------

/** Trim and bound a poll body, throwing `PayloadValidationError` with a user-readable reason. */
export function validatePoll(input: PollPayload): PollPayload {
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (question.length === 0) {
        throw new PayloadValidationError('A poll needs a question.');
    }
    if (question.length > POLL_QUESTION_MAX) {
        throw new PayloadValidationError(`The question is limited to ${POLL_QUESTION_MAX} characters.`);
    }

    if (!Array.isArray(input.options)) {
        throw new PayloadValidationError('A poll needs options.');
    }
    // Bounded before any per-item work, so a hostile payload cannot make us map a huge array.
    if (input.options.length < POLL_OPTIONS_MIN || input.options.length > POLL_OPTIONS_MAX) {
        throw new PayloadValidationError(`A poll needs ${POLL_OPTIONS_MIN} to ${POLL_OPTIONS_MAX} options.`);
    }
    const options = input.options.map((option) => (typeof option === 'string' ? option.trim() : ''));
    if (options.length < POLL_OPTIONS_MIN || options.length > POLL_OPTIONS_MAX) {
        throw new PayloadValidationError(`A poll needs ${POLL_OPTIONS_MIN} to ${POLL_OPTIONS_MAX} options.`);
    }
    if (options.some((option) => option.length === 0)) {
        throw new PayloadValidationError('Options cannot be empty.');
    }
    if (options.some((option) => option.length > POLL_OPTION_MAX)) {
        throw new PayloadValidationError(`Each option is limited to ${POLL_OPTION_MAX} characters.`);
    }

    if (typeof input.multiple !== 'boolean' || typeof input.anonymous !== 'boolean') {
        throw new PayloadValidationError('Malformed poll settings.');
    }

    let closesAt: string | null = null;
    if (input.closesAt !== null && input.closesAt !== undefined) {
        if (!isIsoDate(input.closesAt)) {
            throw new PayloadValidationError('The closing time is not a valid date.');
        }
        closesAt = new Date(input.closesAt).toISOString();
    }

    return { question, options, multiple: input.multiple, anonymous: input.anonymous, closesAt };
}

export function validateVote(input: PollVotePayload): PollVotePayload {
    if (!isObjectId(input.pollId)) {
        throw new PayloadValidationError('Malformed poll id.');
    }
    const options = input.options;
    if (
        !Array.isArray(options) ||
        options.length < 1 ||
        options.length > POLL_OPTIONS_MAX ||
        options.some((index) => !Number.isInteger(index) || index < 0 || index >= POLL_OPTIONS_MAX) ||
        new Set(options).size !== options.length
    ) {
        throw new PayloadValidationError('Malformed vote.');
    }
    return { pollId: input.pollId, options: [...options].sort((a, b) => a - b) };
}

export function validateClose(input: PollClosePayload): PollClosePayload {
    if (!isObjectId(input.pollId)) {
        throw new PayloadValidationError('Malformed poll id.');
    }
    return { pollId: input.pollId };
}

/** Range-check a location. The label is clamped rather than rejected: it is cosmetic. */
export function validateLocation(input: LocationPayload): LocationPayload {
    if (!isValidLatitude(input.lat) || !isValidLongitude(input.lon)) {
        throw new PayloadValidationError('The coordinates are out of range.');
    }

    let accuracy: number | null = null;
    if (input.accuracy !== null && input.accuracy !== undefined) {
        if (!isFiniteNumber(input.accuracy) || input.accuracy < 0 || input.accuracy > LOCATION_ACCURACY_MAX) {
            throw new PayloadValidationError('The accuracy is not valid.');
        }
        accuracy = input.accuracy;
    }

    let label: string | null = null;
    if (input.label !== null && input.label !== undefined) {
        if (typeof input.label !== 'string') {
            throw new PayloadValidationError('The label is not valid.');
        }
        const clamped = input.label.trim().slice(0, LOCATION_LABEL_MAX);
        label = clamped.length > 0 ? clamped : null;
    }

    return { lat: roundCoordinate(input.lat), lon: roundCoordinate(input.lon), accuracy, label };
}

// ---------------------------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------------------------

/** Short text an older client can show for a payload it does not understand. */
export function fallbackText(content: TypedContent): string {
    switch (content.kind) {
        case 'poll':
            return `Poll: ${content.poll.question}`;
        case 'location':
            return 'Location';
        default:
            return '';
    }
}

/**
 * The JSON object to seal for a typed payload. Validates first, so an invalid payload never
 * reaches the wire.
 */
export function encodeTypedPayload(content: TypedContent): Record<string, unknown> {
    const base = { v: PAYLOAD_VERSION, type: content.kind, attachmentKeys: [] as unknown[] };

    switch (content.kind) {
        case 'poll': {
            const poll = validatePoll(content.poll);
            return {
                ...base,
                text: fallbackText({ kind: 'poll', poll }),
                poll: {
                    question: poll.question,
                    options: poll.options,
                    multiple: poll.multiple,
                    anonymous: poll.anonymous,
                    closes_at: poll.closesAt,
                },
            };
        }
        case 'poll_vote': {
            const vote = validateVote(content.vote);
            return { ...base, text: '', poll_vote: { poll_id: vote.pollId, options: vote.options } };
        }
        case 'poll_close': {
            const close = validateClose(content.close);
            return { ...base, text: '', poll_close: { poll_id: close.pollId } };
        }
        case 'location': {
            const location = validateLocation(content.location);
            return {
                ...base,
                text: 'Location',
                location: {
                    lat: location.lat,
                    lon: location.lon,
                    accuracy: location.accuracy,
                    label: location.label,
                },
            };
        }
    }
}

function parsePollBody(body: unknown): PollPayload | null {
    if (!isRecord(body)) {
        return null;
    }
    try {
        return validatePoll({
            question: body['question'] as string,
            options: body['options'] as string[],
            multiple: body['multiple'] as boolean,
            anonymous: body['anonymous'] as boolean,
            closesAt: (body['closes_at'] ?? null) as string | null,
        });
    } catch {
        return null;
    }
}

function parseVoteBody(body: unknown): PollVotePayload | null {
    if (!isRecord(body)) {
        return null;
    }
    try {
        return validateVote({ pollId: body['poll_id'] as string, options: body['options'] as number[] });
    } catch {
        return null;
    }
}

function parseCloseBody(body: unknown): PollClosePayload | null {
    if (!isRecord(body)) {
        return null;
    }
    try {
        return validateClose({ pollId: body['poll_id'] as string });
    } catch {
        return null;
    }
}

function parseLocationBody(body: unknown): LocationPayload | null {
    if (!isRecord(body)) {
        return null;
    }
    try {
        return validateLocation({
            lat: body['lat'] as number,
            lon: body['lon'] as number,
            accuracy: (body['accuracy'] ?? null) as number | null,
            label: (body['label'] ?? null) as string | null,
        });
    } catch {
        return null;
    }
}

/**
 * Decide what a decrypted plaintext object is.
 *
 * `isControl` is the server-visible `is_control` flag. A vote or close is only meaningful as a
 * control message, and a control message may only be a vote or close, so a mismatch in either
 * direction is `misplaced`: shown as unsupported (or ignored, for control messages) instead of
 * being counted or rendered as something it was not sent as.
 *
 * Returns the `text` to display alongside the classification, which is only set for text.
 */
export function classifyPlaintext(
    parsed: unknown,
    isControl: boolean
): { content: MessageContent; text: string | null } {
    const typeValue = isRecord(parsed) ? parsed['type'] : undefined;

    // Typed means BOTH `v` and `type` are present. A bare `type` key belongs to some other JSON
    // that happened to be a legacy plaintext, and stays ordinary text.
    if (!isRecord(parsed) || typeValue === undefined || !('v' in parsed)) {
        // Untyped: ordinary text. A control message must be typed.
        return isControl
            ? { content: { kind: 'unsupported', reason: 'misplaced', type: null }, text: null }
            : { content: TEXT_CONTENT, text: null };
    }

    const type = typeof typeValue === 'string' ? typeValue.slice(0, 40) : null;
    const unsupported = (reason: UnsupportedReason) => ({
        content: { kind: 'unsupported', reason, type } as MessageContent,
        text: null,
    });

    const version = parsed['v'];
    if (version !== PAYLOAD_VERSION) {
        return unsupported(isFiniteNumber(version) && version > PAYLOAD_VERSION ? 'newer_version' : 'malformed');
    }

    let content: MessageContent | null;
    switch (typeValue) {
        case 'poll': {
            const poll = parsePollBody(parsed['poll']);
            content = poll ? { kind: 'poll', poll } : null;
            break;
        }
        case 'poll_vote': {
            const vote = parseVoteBody(parsed['poll_vote']);
            content = vote ? { kind: 'poll_vote', vote } : null;
            break;
        }
        case 'poll_close': {
            const close = parseCloseBody(parsed['poll_close']);
            content = close ? { kind: 'poll_close', close } : null;
            break;
        }
        case 'location': {
            const location = parseLocationBody(parsed['location']);
            content = location ? { kind: 'location', location } : null;
            break;
        }
        default:
            return unsupported('unknown_type');
    }

    if (!content) {
        return unsupported('malformed');
    }
    if (isControlContent(content) !== isControl) {
        return unsupported('misplaced');
    }
    return { content, text: null };
}

/** One line for previews, quotes and the chat list. Null for plain text (which has its own text). */
export function summarizeContent(content: MessageContent): string | null {
    switch (content.kind) {
        case 'poll':
            return `Poll: ${content.poll.question}`;
        case 'location':
            return content.location.label ? `Location: ${content.location.label}` : 'Location';
        case 'unsupported':
            return 'Unsupported message';
        case 'poll_vote':
        case 'poll_close':
            return 'Poll update';
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------------------------
// Display and links
// ---------------------------------------------------------------------------------------------

/** Rounded for reading; the full-precision values stay in the payload. */
export function formatCoordinates(lat: number, lon: number): string {
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/**
 * OpenStreetMap link for a validated location, or null for out-of-range input. A plain link the
 * user follows: nothing is fetched from the map provider by this app (no tiles, no scripts).
 */
export function openStreetMapUrl(lat: number, lon: number): string | null {
    if (!isValidLatitude(lat) || !isValidLongitude(lon)) {
        return null;
    }
    const latText = lat.toFixed(COORDINATE_DECIMALS);
    const lonText = lon.toFixed(COORDINATE_DECIMALS);
    return `https://www.openstreetmap.org/?mlat=${latText}&mlon=${lonText}#map=16/${latText}/${lonText}`;
}
