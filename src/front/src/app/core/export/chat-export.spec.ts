import { PollControl } from '../polls/poll-tally';
import { DecryptedMessage, DecryptStatus } from '../services/message.service';
import {
    buildChatExport,
    collectExportUserIds,
    exportFileName,
    ExportInput,
    ExportPollVotes,
    serializeExport,
} from './chat-export';

const POLL = '64b000000000000000000100';
const NAMES: Record<string, string> = { alice: 'Alice', bob: 'Bob', carol: 'Carol' };
const KEY_MATERIAL = 'c2VjcmV0LWtleS1ieXRlcy1ub3QtZm9yLXRoZS1maWxl';

function message(id: string, overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id,
        chatId: 'chat',
        senderId: 'alice',
        createdAt: '2026-06-01T10:00:00Z',
        text: 'hello',
        status: 'ok',
        isEdited: false,
        replyToId: null,
        forwardedFrom: null,
        attachments: [],
        senderVerified: true,
        reactions: [],
        isPinned: false,
        ...overrides,
    };
}

function vote(n: number, sender: string, options: number[]): PollControl {
    return {
        id: `64b00000000000000000020${n}`,
        senderId: sender,
        createdAt: '2026-06-01T10:05:00Z',
        pollMessageId: POLL,
        trusted: true,
        content: { kind: 'poll_vote', vote: { pollId: POLL, options } },
    };
}

function input(messages: DecryptedMessage[], overrides: Partial<ExportInput> = {}): ExportInput {
    return {
        chat: { id: 'chat', type: 'group', title: 'Team' },
        participants: [
            { userId: 'alice', role: 'owner' },
            { userId: 'bob', role: 'member' },
        ],
        messages,
        nameOf: (id) => NAMES[id] ?? id,
        pollVotes: new Map(),
        memberIds: new Set(['alice', 'bob']),
        historyFloor: false,
        exportedAt: new Date('2026-07-01T00:00:00Z'),
        ...overrides,
    };
}

describe('buildChatExport', () => {
    it('describes the file and the chat', () => {
        const doc = buildChatExport(input([message('64b000000000000000000001')], { historyFloor: true }));

        expect(doc.format).toBe('messgags-chat-export');
        expect(doc.version).toBe(1);
        expect(doc.exported_at).toBe('2026-07-01T00:00:00.000Z');
        expect(doc.contains_decrypted_content).toBeTrue();
        expect(doc.chat).toEqual({ id: 'chat', type: 'group', title: 'Team', history_floor: true });
        expect(doc.participants).toEqual([
            { id: 'alice', name: 'Alice', role: 'owner' },
            { id: 'bob', name: 'Bob', role: 'member' },
        ]);
        expect(doc.message_count).toBe(1);
    });

    it('exports ordinary messages in id order with sender, reply, forward, edit and reactions', () => {
        const doc = buildChatExport(
            input([
                message('64b000000000000000000002', {
                    senderId: 'bob',
                    text: 'second',
                    replyToId: '64b000000000000000000001',
                    isEdited: true,
                    editedAt: '2026-06-01T11:00:00Z',
                    forwardedFrom: { user_id: 'carol', created_at: '2026-05-01T00:00:00Z' },
                    reactions: [{ user_id: 'alice', emoji: '👍', created_at: '2026-06-01T10:10:00Z' }],
                }),
                message('64b000000000000000000001'),
            ])
        );

        expect(doc.messages.map((m) => m.id)).toEqual(['64b000000000000000000001', '64b000000000000000000002']);
        const second = doc.messages[1];
        expect(second.sender).toEqual({ id: 'bob', name: 'Bob' });
        expect(second.kind).toBe('text');
        expect(second.text).toBe('second');
        expect(second.reply_to).toBe('64b000000000000000000001');
        expect(second.edited).toBeTrue();
        expect(second.edited_at).toBe('2026-06-01T11:00:00Z');
        expect(second.forwarded_from).toEqual({
            user: { id: 'carol', name: 'Carol' },
            created_at: '2026-05-01T00:00:00Z',
        });
        expect(second.reactions).toEqual([
            { emoji: '👍', user: { id: 'alice', name: 'Alice' }, created_at: '2026-06-01T10:10:00Z' },
        ]);
    });

    describe('undecryptable messages', () => {
        for (const status of ['no_key', 'failed', 'legacy'] as DecryptStatus[]) {
            it(`keeps a ${status} message with its status instead of dropping it`, () => {
                const doc = buildChatExport(
                    input([
                        message('64b000000000000000000001', {
                            status,
                            text: null,
                            senderVerified: false,
                            attachments: [{ url: 'k', name: 'secret.png', size: 1, content_type: 'image/png' }],
                        }),
                    ])
                );

                expect(doc.message_count).toBe(1);
                expect(doc.messages[0].status).toBe(status);
                expect(doc.messages[0].kind).toBe('unreadable');
                expect(doc.messages[0].text).toBeNull();
                // Metadata the server asserted, not content: not vouched for, so not listed.
                expect(doc.messages[0].attachments).toEqual([]);
            });
        }

        it('keeps an unverified message but says it is unverified', () => {
            const doc = buildChatExport(
                input([message('64b000000000000000000001', { status: 'unverified', senderVerified: false })])
            );
            expect(doc.messages[0].status).toBe('unverified');
            expect(doc.messages[0].sender_verified).toBeFalse();
        });
    });

    it('lists attachment metadata only, never the url or key', () => {
        const doc = buildChatExport(
            input([
                message('64b000000000000000000001', {
                    attachments: [
                        {
                            url: 'http://objects/abc123.bin',
                            name: 'photo.jpg',
                            size: 2048,
                            content_type: 'image/jpeg',
                            kind: 'image',
                            decryptionKey: new Uint8Array([1, 2, 3]),
                            waveform: [0.1],
                        },
                    ],
                }),
            ])
        );

        expect(doc.messages[0].attachments).toEqual([
            { name: 'photo.jpg', type: 'image/jpeg', size: 2048, kind: 'image' },
        ]);
        const json = serializeExport(doc);
        expect(json).not.toContain('abc123');
        expect(json).not.toContain('decryptionKey');
        expect(json).not.toContain(KEY_MATERIAL);
        expect(json).not.toContain('envelope');
    });

    it('drops control messages entirely', () => {
        const doc = buildChatExport(
            input([
                message('64b000000000000000000001'),
                message('64b000000000000000000002', {
                    isControl: true,
                    text: null,
                    content: { kind: 'poll_vote', vote: { pollId: POLL, options: [0] } },
                }),
            ])
        );
        expect(doc.messages.map((m) => m.id)).toEqual(['64b000000000000000000001']);
    });

    describe('polls', () => {
        const pollMessage = (anonymous: boolean) =>
            message(POLL, {
                text: null,
                content: {
                    kind: 'poll',
                    poll: {
                        question: 'Lunch?',
                        options: ['Pizza', 'Sushi'],
                        multiple: false,
                        anonymous,
                        closesAt: null,
                    },
                },
            });
        const votes = (controls: PollControl[], extra: Partial<ExportPollVotes> = {}): ExportPollVotes => ({
            controls,
            failed: false,
            truncated: false,
            ...extra,
        });
        const controls = new Map<string, ExportPollVotes>([
            [POLL, votes([vote(1, 'alice', [0]), vote(2, 'bob', [0])])],
        ]);

        it('marks a complete poll as complete', () => {
            const poll = buildChatExport(input([pollMessage(false)], { pollVotes: controls })).messages[0].poll!;
            expect(poll.votes_complete).toBeTrue();
            expect(poll.votes_unreadable).toBe(0);
            expect(poll.votes_truncated).toBeFalse();
            expect(poll.votes_fetch_failed).toBeFalse();
        });

        it('never writes an empty tally for a failed fetch without saying so', () => {
            const poll = buildChatExport(
                input([pollMessage(false)], {
                    pollVotes: new Map([[POLL, votes([], { failed: true })]]),
                })
            ).messages[0].poll!;

            expect(poll.total_voters).toBe(0);
            expect(poll.votes_complete).toBeFalse();
            expect(poll.votes_fetch_failed).toBeTrue();
        });

        it('treats a poll with no fetch result at all as incomplete', () => {
            const poll = buildChatExport(input([pollMessage(false)])).messages[0].poll!;
            expect(poll.votes_complete).toBeFalse();
            expect(poll.votes_fetch_failed).toBeTrue();
        });

        it('marks a truncated vote list incomplete', () => {
            const poll = buildChatExport(
                input([pollMessage(false)], {
                    pollVotes: new Map([[POLL, votes([vote(1, 'alice', [0])], { truncated: true })]]),
                })
            ).messages[0].poll!;
            expect(poll.votes_truncated).toBeTrue();
            expect(poll.votes_complete).toBeFalse();
        });

        it('counts votes that could not be read and marks the poll incomplete', () => {
            const unreadable = { ...vote(2, 'bob', [0]), trusted: false };
            const poll = buildChatExport(
                input([pollMessage(false)], {
                    pollVotes: new Map([[POLL, votes([vote(1, 'alice', [0]), unreadable])]]),
                })
            ).messages[0].poll!;

            expect(poll.total_voters).toBe(1);
            expect(poll.votes_unreadable).toBe(1);
            expect(poll.votes_complete).toBeFalse();
        });

        it('tallies a poll whose message is unverified the same way as a verified one', () => {
            const unverified = { ...pollMessage(false), status: 'unverified' as const, senderVerified: false };
            const poll = buildChatExport(input([unverified], { pollVotes: controls })).messages[0].poll!;
            expect(poll.total_voters).toBe(2);
        });

        it('ignores votes cast before the author edited the poll', () => {
            const edited = { ...pollMessage(false), isEdited: true, editedAt: '2026-06-01T10:03:00Z' };
            const poll = buildChatExport(input([edited], { pollVotes: controls })).messages[0].poll!;
            // Both votes are stamped 10:05, after the edit, so they still count.
            expect(poll.total_voters).toBe(2);

            const late = { ...edited, editedAt: '2026-06-01T10:30:00Z' };
            expect(buildChatExport(input([late], { pollVotes: controls })).messages[0].poll!.total_voters).toBe(0);
        });

        it('lists voters of a public poll', () => {
            const doc = buildChatExport(input([pollMessage(false)], { pollVotes: controls }));
            const poll = doc.messages[0].poll!;

            expect(doc.messages[0].kind).toBe('poll');
            expect(poll.question).toBe('Lunch?');
            expect(poll.total_voters).toBe(2);
            expect(poll.options[0]).toEqual({
                text: 'Pizza',
                votes: 2,
                voters: [
                    { id: 'alice', name: 'Alice' },
                    { id: 'bob', name: 'Bob' },
                ],
            });
            expect(poll.options[1].votes).toBe(0);
        });

        it('exports only the tallies of an anonymous poll', () => {
            const doc = buildChatExport(input([pollMessage(true)], { pollVotes: controls }));
            const poll = doc.messages[0].poll!;

            expect(poll.options[0].votes).toBe(2);
            expect(poll.voters_omitted).toBeTrue();
            expect(poll.options.every((option) => !('voters' in option))).toBeTrue();

            const json = serializeExport(doc);
            expect(json).not.toContain('"voters"');
            // The poll body names nobody who voted; "Alice" and "Bob" appear only as participants.
            expect(JSON.stringify(doc.messages)).not.toContain('Bob');
        });

        it('reports a closed poll', () => {
            const closed: PollControl = {
                id: '64b000000000000000000209',
                senderId: 'alice',
                createdAt: '2026-06-01T12:00:00Z',
                pollMessageId: POLL,
                trusted: true,
                content: { kind: 'poll_close', close: { pollId: POLL } },
            };
            const doc = buildChatExport(
                input([pollMessage(false)], {
                    pollVotes: new Map([[POLL, votes([vote(1, 'alice', [0]), closed])]]),
                })
            );
            expect(doc.messages[0].poll!.closed).toBeTrue();
            expect(doc.messages[0].poll!.closed_by).toBe('author');
        });
    });

    it('exports a location at full precision', () => {
        const location = { lat: 50.4501234567, lon: 30.5234567891, accuracy: 10, label: 'Home' };
        const doc = buildChatExport(
            input([message('64b000000000000000000001', { text: null, content: { kind: 'location', location } })])
        );
        expect(doc.messages[0].kind).toBe('location');
        expect(doc.messages[0].location).toEqual(location);
    });

    it('marks an unsupported message as such', () => {
        const doc = buildChatExport(
            input([
                message('64b000000000000000000001', {
                    text: null,
                    content: { kind: 'unsupported', reason: 'unknown_type', type: 'hologram' },
                }),
            ])
        );
        expect(doc.messages[0].kind).toBe('unsupported');
        expect(doc.messages[0].unsupported_reason).toBe('unknown_type');
    });
});

describe('export helpers', () => {
    it('makes a filesystem-safe file name', () => {
        const at = new Date('2026-07-01T00:00:00Z');
        expect(exportFileName('Team / "Dev": 2026?', at)).toBe('Team-Dev-2026-2026-07-01.json');
        expect(exportFileName(null, at)).toBe('chat-2026-07-01.json');
        expect(exportFileName('???', at)).toBe('chat-2026-07-01.json');
    });

    it('collects every user the file will name', () => {
        const ids = collectExportUserIds(
            [
                message('64b000000000000000000001', {
                    senderId: 'bob',
                    forwardedFrom: { user_id: 'carol', created_at: 'x' },
                    reactions: [{ user_id: 'dave', emoji: 'x', created_at: 'x' }],
                }),
            ],
            ['alice'],
            new Map([[POLL, { controls: [vote(1, 'erin', [0])], failed: false, truncated: false }]])
        );
        expect(ids.sort()).toEqual(['alice', 'bob', 'carol', 'dave', 'erin']);
    });
});
