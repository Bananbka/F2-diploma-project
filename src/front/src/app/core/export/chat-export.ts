import { MessageAttachment } from '../models/crypto.model';
import { LocationPayload } from '../models/message-payload';
import { PollControl, tallyPoll } from '../polls/poll-tally';
import { contentOf, DecryptedMessage, DecryptStatus } from '../services/message.service';

export const EXPORT_FORMAT = 'messgags-chat-export';
export const EXPORT_VERSION = 1;

export interface ExportPerson {
    id: string;
    name: string;
}

export interface ExportAttachment {
    name: string;
    type: string;
    size: number;
    kind: string | null;
}

export interface ExportPoll {
    question: string;
    options: { text: string; votes: number; voters?: ExportPerson[] }[];
    total_voters: number;
    multiple: boolean;
    anonymous: boolean;
    closed: boolean;
    closed_by: 'author' | 'time' | null;
    closes_at: string | null;
    /** Present (and true) for an anonymous poll: voter identities were deliberately not exported. */
    voters_omitted?: true;
    /**
     * False when the tally may be missing votes: the vote fetch failed, hit its page cap, or some
     * votes could not be read. The counts are then a lower bound, not a result.
     */
    votes_complete: boolean;
    /** Votes filed under this poll that could not be opened or verified, and so are not counted. */
    votes_unreadable: number;
    /** The vote list was cut off at the page cap. */
    votes_truncated: boolean;
    /** The vote fetch failed outright; the counts below are zero for want of data, not because nobody voted. */
    votes_fetch_failed: boolean;
}

/** What was obtained for one poll's votes. A missing entry is treated as a failed fetch. */
export interface ExportPollVotes {
    controls: readonly PollControl[];
    failed: boolean;
    truncated: boolean;
}

export type ExportKind = 'text' | 'poll' | 'location' | 'unsupported' | 'unreadable';

export interface ExportMessage {
    id: string;
    timestamp: string;
    sender: ExportPerson;
    /** The decrypt outcome. Anything other than ok/plaintext means the content below is absent or doubtful. */
    status: DecryptStatus;
    sender_verified: boolean;
    kind: ExportKind;
    text: string | null;
    reply_to: string | null;
    forwarded_from: { user: ExportPerson; created_at: string } | null;
    edited: boolean;
    edited_at: string | null;
    reactions: { emoji: string; user: ExportPerson; created_at: string }[];
    attachments: ExportAttachment[];
    poll?: ExportPoll;
    location?: LocationPayload;
    unsupported_reason?: string;
}

export interface ChatExportDocument {
    format: typeof EXPORT_FORMAT;
    version: typeof EXPORT_VERSION;
    exported_at: string;
    /** This file holds decrypted content. It is plain JSON: protect it accordingly. */
    contains_decrypted_content: true;
    chat: {
        id: string;
        type: string;
        title: string | null;
        /** Older history exists on the server but was withheld from this account (joined-only history). */
        history_floor: boolean;
    };
    participants: (ExportPerson & { role: string | null })[];
    message_count: number;
    /** Messages whose content is absent because they could not be decrypted (see each `status`). */
    unreadable_count: number;
    messages: ExportMessage[];
}

export interface ExportInput {
    chat: { id: string; type: string; title: string | null };
    participants: { userId: string; role: string | null }[];
    /** Any order; sorted here by message id. Control messages are dropped. */
    messages: readonly DecryptedMessage[];
    nameOf: (userId: string) => string;
    /** Votes per poll message id. */
    pollVotes: ReadonlyMap<string, ExportPollVotes>;
    memberIds: ReadonlySet<string> | null;
    historyFloor: boolean;
    exportedAt: Date;
}

/** The kinds of status whose content was actually read. */
/** True when a message's content was opened (shared with the service so both agree on "readable"). */
export function isReadable(status: DecryptStatus): boolean {
    return status === 'ok' || status === 'plaintext' || status === 'unverified';
}

function attachmentOf(file: MessageAttachment): ExportAttachment {
    // An explicit allow-list: the url (an object key) and decryptionKey never leave this function.
    return {
        name: String(file.name ?? ''),
        type: String(file.content_type ?? ''),
        size: Number.isFinite(file.size) ? file.size : 0,
        kind: file.kind ?? null,
    };
}

/** Pure: everything that goes into the file is decided here, from decrypted values only. */
export function buildChatExport(input: ExportInput): ChatExportDocument {
    const person = (id: string): ExportPerson => ({ id, name: input.nameOf(id) });

    const ordered = input.messages
        .filter((message) => !message.isControl)
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const messages = ordered.map((message): ExportMessage => {
        const readable = isReadable(message.status);
        const content = contentOf(message);

        const entry: ExportMessage = {
            id: message.id,
            timestamp: message.createdAt,
            sender: person(message.senderId),
            status: message.status,
            sender_verified: message.senderVerified,
            kind: 'text',
            text: null,
            reply_to: message.replyToId,
            forwarded_from: message.forwardedFrom
                ? { user: person(message.forwardedFrom.user_id), created_at: message.forwardedFrom.created_at }
                : null,
            edited: message.isEdited,
            edited_at: message.editedAt ?? null,
            reactions: message.reactions.map((reaction) => ({
                emoji: reaction.emoji,
                user: person(reaction.user_id),
                created_at: reaction.created_at,
            })),
            attachments: readable ? message.attachments.map(attachmentOf) : [],
        };

        if (!readable) {
            // Never dropped, never guessed at: the status says why there is no content.
            entry.kind = 'unreadable';
            return entry;
        }

        switch (content.kind) {
            case 'poll': {
                entry.kind = 'poll';
                const votes = input.pollVotes.get(message.id);
                const tally = tallyPoll({
                    pollId: message.id,
                    authorId: message.senderId,
                    poll: content.poll,
                    controls: votes?.controls ?? [],
                    memberIds: input.memberIds,
                    now: input.exportedAt,
                    editedAt: message.isEdited ? message.editedAt : null,
                });
                const failed = !votes || votes.failed;
                const truncated = votes?.truncated === true;
                entry.poll = {
                    question: content.poll.question,
                    options: tally.options.map((option) => ({
                        text: option.text,
                        votes: option.count,
                        // Only a public poll lists voters. For an anonymous one the ids are not even
                        // present in the tally, so there is nothing to leak by mistake.
                        ...(option.voterIds ? { voters: option.voterIds.map(person) } : {}),
                    })),
                    total_voters: tally.totalVoters,
                    multiple: content.poll.multiple,
                    anonymous: content.poll.anonymous,
                    closed: tally.closed,
                    closed_by: tally.closedBy,
                    closes_at: content.poll.closesAt,
                    ...(content.poll.anonymous ? { voters_omitted: true as const } : {}),
                    votes_complete: !failed && !truncated && tally.unreadable === 0,
                    votes_unreadable: tally.unreadable,
                    votes_truncated: truncated,
                    votes_fetch_failed: failed,
                };
                break;
            }
            case 'location':
                entry.kind = 'location';
                entry.location = { ...content.location };
                break;
            case 'unsupported':
                entry.kind = 'unsupported';
                entry.unsupported_reason = content.reason;
                break;
            default:
                entry.text = message.text;
        }
        return entry;
    });

    return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exported_at: input.exportedAt.toISOString(),
        contains_decrypted_content: true,
        chat: {
            id: input.chat.id,
            type: input.chat.type,
            title: input.chat.title,
            history_floor: input.historyFloor,
        },
        participants: input.participants.map((p) => ({ id: p.userId, name: input.nameOf(p.userId), role: p.role })),
        message_count: messages.length,
        unreadable_count: messages.filter((m) => m.kind === 'unreadable').length,
        messages,
    };
}

export function serializeExport(document: ChatExportDocument): string {
    return JSON.stringify(document, null, 2);
}

/** A filesystem-safe name: no path separators or characters Windows rejects. */
export function exportFileName(title: string | null, at: Date): string {
    const base = (title ?? 'chat')
        .normalize('NFKD')
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 40);
    return `${base || 'chat'}-${at.toISOString().slice(0, 10)}.json`;
}

/** Every user id the document will name, so their names can be resolved in one request first. */
export function collectExportUserIds(
    messages: readonly DecryptedMessage[],
    participantIds: readonly string[],
    pollVotes: ReadonlyMap<string, ExportPollVotes>
): string[] {
    const ids = new Set<string>(participantIds);
    for (const message of messages) {
        ids.add(message.senderId);
        if (message.forwardedFrom) {
            ids.add(message.forwardedFrom.user_id);
        }
        message.reactions.forEach((reaction) => ids.add(reaction.user_id));
    }
    for (const votes of pollVotes.values()) {
        votes.controls.forEach((control) => ids.add(control.senderId));
    }
    return [...ids];
}
