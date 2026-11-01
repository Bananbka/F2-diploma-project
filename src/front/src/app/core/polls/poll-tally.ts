import { isObjectId, MessageContent, PollPayload } from '../models/message-payload';

/**
 * One decrypted control message (a vote or a close) as the tally sees it.
 *
 * `trusted` is the decrypt result collapsed to what matters here: the envelope opened AND the sender
 * signature was checked. An unreadable, unverified or failed control message never counts.
 */
export interface PollControl {
    /** Mongo ObjectId (24 lowercase hex): the ordering key, exactly as for ordinary messages. */
    id: string;
    senderId: string;
    createdAt: string;
    /** The server-visible `poll_message_id` the control message was filed under. */
    pollMessageId: string | null;
    trusted: boolean;
    content: MessageContent;
}

export interface PollTallyInput {
    pollId: string;
    authorId: string;
    poll: PollPayload;
    controls: readonly PollControl[];
    /** Current members. `null` means the roster is not known yet, in which case nobody is filtered. */
    memberIds: ReadonlySet<string> | null;
    /** The poll message was deleted: nothing counts. */
    deleted?: boolean;
    now: Date;
    meId?: string | null;
    /**
     * When the author last edited the poll (server timestamp). Votes cast before it were for a
     * different question or option list, so they are not counted.
     */
    editedAt?: string | null;
}

export interface PollOptionTally {
    index: number;
    text: string;
    count: number;
    /** Share of voters, 0..100, rounded. */
    percent: number;
    /**
     * Who chose this option. `null` for an anonymous poll: the voter ids are not even placed in the
     * result, so no template can show them by accident.
     */
    voterIds: string[] | null;
}

export interface PollTally {
    options: PollOptionTally[];
    totalVoters: number;
    closed: boolean;
    /** Why it is closed: the author closed it, or its closing time passed. */
    closedBy: 'author' | 'time' | null;
    /** The message id of the author's close, when closed by the author. */
    closeId: string | null;
    /** The current user's own selection, whatever the anonymity mode. */
    mine: number[];
    /** Control messages filed under this poll that could not be opened or verified, so are not counted. */
    unreadable: number;
}

/** ObjectIds are equal-length lowercase hex, so plain string comparison is chronological. */
function compareIds(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function selectionIsValid(selection: readonly number[], poll: PollPayload): boolean {
    if (selection.length === 0 || selection.length > poll.options.length) {
        return false;
    }
    if (!poll.multiple && selection.length !== 1) {
        return false;
    }
    return selection.every((index) => Number.isInteger(index) && index >= 0 && index < poll.options.length);
}

/**
 * Count a poll from its control messages.
 *
 * The rules, each of which exists because a modified client or a misbehaving server could otherwise
 * move a result:
 *
 * - Only controls that decrypted AND verified (`trusted`) count.
 * - The control must be filed under this poll (`pollMessageId`) AND name it inside the sealed body.
 *   The first is server metadata, the second is signed; requiring both stops a vote being replayed
 *   into another poll by whoever controls either field.
 * - A vote older than the poll cannot be for it. Comparing ObjectIds orders them.
 * - The author, and only the author, can close. The earliest valid close wins; votes after it, and
 *   votes created after `closes_at`, are ignored.
 * - A voter must be a current member (when the roster is known).
 * - Per voter the latest valid vote by message id replaces earlier ones. An invalid vote (wrong
 *   arity for single choice, index out of range) is skipped, so it cannot erase a valid earlier one.
 */
export function tallyPoll(input: PollTallyInput): PollTally {
    const { poll, pollId, controls, now } = input;
    const optionCount = poll.options.length;

    const empty = (): PollTally => ({
        options: poll.options.map((text, index) => ({
            index,
            text,
            count: 0,
            percent: 0,
            voterIds: poll.anonymous ? null : [],
        })),
        totalVoters: 0,
        closed: false,
        closedBy: null,
        closeId: null,
        mine: [],
        unreadable: 0,
    });

    if (input.deleted || !isObjectId(pollId)) {
        return empty();
    }

    const closesAtMs = poll.closesAt ? Date.parse(poll.closesAt) : Number.NaN;
    const hasDeadline = !Number.isNaN(closesAtMs);

    const editedAtMs = input.editedAt ? Date.parse(input.editedAt) : Number.NaN;
    const hasEdit = !Number.isNaN(editedAtMs);

    const filed = controls.filter(
        (control) => isObjectId(control.id) && control.pollMessageId === pollId && compareIds(control.id, pollId) > 0
    );
    const unreadable = filed.filter((control) => !control.trusted).length;
    const relevant = filed.filter((control) => control.trusted).sort((a, b) => compareIds(a.id, b.id));

    let closeId: string | null = null;
    for (const control of relevant) {
        if (
            control.content.kind === 'poll_close' &&
            control.content.close.pollId === pollId &&
            control.senderId === input.authorId
        ) {
            closeId = control.id;
            break;
        }
    }

    const latest = new Map<string, number[]>();
    for (const control of relevant) {
        if (control.content.kind !== 'poll_vote' || control.content.vote.pollId !== pollId) {
            continue;
        }
        if (closeId !== null && compareIds(control.id, closeId) > 0) {
            continue;
        }
        if (hasEdit) {
            const created = Date.parse(control.createdAt);
            if (Number.isNaN(created) || created < editedAtMs) {
                continue;
            }
        }
        if (hasDeadline) {
            const created = Date.parse(control.createdAt);
            if (Number.isNaN(created) || created > closesAtMs) {
                continue;
            }
        }
        if (input.memberIds !== null && !input.memberIds.has(control.senderId)) {
            continue;
        }
        if (!selectionIsValid(control.content.vote.options, poll)) {
            continue;
        }
        // Ascending order, so a later vote simply overwrites.
        latest.set(control.senderId, control.content.vote.options);
    }

    const voters: string[][] = Array.from({ length: optionCount }, () => []);
    for (const [voterId, selection] of latest) {
        for (const index of selection) {
            voters[index].push(voterId);
        }
    }

    const totalVoters = latest.size;
    const options: PollOptionTally[] = poll.options.map((text, index) => ({
        index,
        text,
        count: voters[index].length,
        percent: totalVoters === 0 ? 0 : Math.round((voters[index].length / totalVoters) * 100),
        voterIds: poll.anonymous ? null : voters[index],
    }));

    const closedByTime = hasDeadline && now.getTime() >= closesAtMs;
    const closed = closeId !== null || closedByTime;

    return {
        options,
        totalVoters,
        closed,
        closedBy: closeId !== null ? 'author' : closedByTime ? 'time' : null,
        closeId,
        mine: input.meId ? (latest.get(input.meId) ?? []) : [],
        unreadable,
    };
}
