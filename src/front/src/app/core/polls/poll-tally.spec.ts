import { PollPayload } from '../models/message-payload';
import { PollControl, PollTallyInput, tallyPoll } from './poll-tally';

const POLL = '64b000000000000000000100';
const AUTHOR = 'author';
const ALICE = 'alice';
const BOB = 'bob';
const NOW = new Date('2026-06-01T12:00:00Z');

/** Ids are increasing hex, so string order is creation order, like real ObjectIds. */
const id = (n: number) => `64b0000000000000000002${n.toString(16).padStart(2, '0')}`;

function poll(overrides: Partial<PollPayload> = {}): PollPayload {
    return {
        question: 'Lunch?',
        options: ['Pizza', 'Sushi', 'Soup'],
        multiple: false,
        anonymous: false,
        closesAt: null,
        ...overrides,
    };
}

function vote(n: number, sender: string, options: number[], extra: Partial<PollControl> = {}): PollControl {
    return {
        id: id(n),
        senderId: sender,
        createdAt: '2026-06-01T10:00:00Z',
        pollMessageId: POLL,
        trusted: true,
        content: { kind: 'poll_vote', vote: { pollId: POLL, options } },
        ...extra,
    };
}

function close(n: number, sender: string, extra: Partial<PollControl> = {}): PollControl {
    return {
        id: id(n),
        senderId: sender,
        createdAt: '2026-06-01T10:30:00Z',
        pollMessageId: POLL,
        trusted: true,
        content: { kind: 'poll_close', close: { pollId: POLL } },
        ...extra,
    };
}

function tally(controls: PollControl[], overrides: Partial<PollTallyInput> = {}, p: PollPayload = poll()) {
    return tallyPoll({
        pollId: POLL,
        authorId: AUTHOR,
        poll: p,
        controls,
        memberIds: new Set([AUTHOR, ALICE, BOB]),
        now: NOW,
        meId: ALICE,
        ...overrides,
    });
}

const counts = (controls: PollControl[], overrides: Partial<PollTallyInput> = {}, p?: PollPayload) =>
    tally(controls, overrides, p).options.map((o) => o.count);

describe('tallyPoll', () => {
    it('is all zero with no votes', () => {
        const result = tally([]);
        expect(result.options.map((o) => o.count)).toEqual([0, 0, 0]);
        expect(result.totalVoters).toBe(0);
        expect(result.closed).toBeFalse();
        expect(result.options.every((o) => o.percent === 0)).toBeTrue();
    });

    it('counts one vote per voter and computes percentages of voters', () => {
        const result = tally([vote(1, ALICE, [0]), vote(2, BOB, [0]), vote(3, AUTHOR, [1])]);
        expect(result.options.map((o) => o.count)).toEqual([2, 1, 0]);
        expect(result.options.map((o) => o.percent)).toEqual([67, 33, 0]);
        expect(result.totalVoters).toBe(3);
    });

    describe('replacement', () => {
        it('the latest vote of a voter replaces the earlier one', () => {
            expect(counts([vote(1, ALICE, [0]), vote(2, ALICE, [2])])).toEqual([0, 0, 1]);
        });

        it('orders by message id, not by the order they were supplied', () => {
            expect(counts([vote(5, ALICE, [2]), vote(2, ALICE, [0])])).toEqual([0, 0, 1]);
        });

        it('an invalid later vote does not erase a valid earlier one', () => {
            expect(counts([vote(1, ALICE, [0]), vote(2, ALICE, [0, 1])])).toEqual([1, 0, 0]);
            expect(counts([vote(1, ALICE, [0]), vote(2, ALICE, [7])])).toEqual([1, 0, 0]);
        });
    });

    describe('single versus multiple choice', () => {
        it('single choice rejects a multi-option vote', () => {
            expect(counts([vote(1, ALICE, [0, 1])])).toEqual([0, 0, 0]);
        });

        it('multiple choice counts every chosen option, once per voter', () => {
            const result = tally([vote(1, ALICE, [0, 2]), vote(2, BOB, [2])], {}, poll({ multiple: true }));
            expect(result.options.map((o) => o.count)).toEqual([1, 0, 2]);
            expect(result.totalVoters).toBe(2);
            expect(result.options.map((o) => o.percent)).toEqual([50, 0, 100]);
        });

        it('rejects an index outside the poll', () => {
            expect(counts([vote(1, ALICE, [3])])).toEqual([0, 0, 0]);
        });
    });

    describe('closing', () => {
        it('the author can close, and later votes are ignored', () => {
            const result = tally([vote(1, ALICE, [0]), close(2, AUTHOR), vote(3, BOB, [1])]);
            expect(result.closed).toBeTrue();
            expect(result.closedBy).toBe('author');
            expect(result.options.map((o) => o.count)).toEqual([1, 0, 0]);
        });

        it('a vote cannot replace an earlier one after the close', () => {
            expect(counts([vote(1, ALICE, [0]), close(2, AUTHOR), vote(3, ALICE, [1])])).toEqual([1, 0, 0]);
        });

        it('a close from anyone else is ignored', () => {
            const result = tally([vote(1, ALICE, [0]), close(2, BOB), vote(3, BOB, [1])]);
            expect(result.closed).toBeFalse();
            expect(result.options.map((o) => o.count)).toEqual([1, 1, 0]);
        });

        it('the earliest valid close wins', () => {
            const result = tally([close(4, AUTHOR), vote(2, ALICE, [0]), vote(5, BOB, [1]), close(3, BOB)]);
            expect(result.closeId).toBe(id(4));
            expect(result.options.map((o) => o.count)).toEqual([1, 0, 0]);
        });

        it('closes when the deadline passes, and ignores votes created after it', () => {
            const timed = poll({ closesAt: '2026-06-01T11:00:00Z' });
            const result = tally(
                [vote(1, ALICE, [0]), vote(2, BOB, [1], { createdAt: '2026-06-01T11:30:00Z' })],
                {},
                timed
            );
            expect(result.closed).toBeTrue();
            expect(result.closedBy).toBe('time');
            expect(result.options.map((o) => o.count)).toEqual([1, 0, 0]);
        });

        it('is open before the deadline', () => {
            const result = tally([vote(1, ALICE, [0])], {}, poll({ closesAt: '2026-06-02T00:00:00Z' }));
            expect(result.closed).toBeFalse();
        });
    });

    describe('what is ignored', () => {
        it('a vote from someone who is not a member', () => {
            expect(counts([vote(1, 'mallory', [0]), vote(2, ALICE, [1])])).toEqual([0, 1, 0]);
        });

        it('does not filter by membership while the roster is unknown', () => {
            expect(counts([vote(1, 'mallory', [0])], { memberIds: null })).toEqual([1, 0, 0]);
        });

        it('a control that did not decrypt or verify', () => {
            expect(counts([vote(1, ALICE, [0], { trusted: false })])).toEqual([0, 0, 0]);
            expect(counts([close(2, AUTHOR, { trusted: false }), vote(3, ALICE, [0])])).toEqual([1, 0, 0]);
        });

        it('a vote filed under another poll by the server', () => {
            expect(counts([vote(1, ALICE, [0], { pollMessageId: '64b000000000000000000999' })])).toEqual([0, 0, 0]);
            expect(counts([vote(1, ALICE, [0], { pollMessageId: null })])).toEqual([0, 0, 0]);
        });

        it('a vote whose sealed body names a different poll (forged poll id)', () => {
            const forged = vote(1, ALICE, [0], {
                content: { kind: 'poll_vote', vote: { pollId: '64b000000000000000000999', options: [0] } },
            });
            expect(counts([forged])).toEqual([0, 0, 0]);
        });

        it('a close whose sealed body names a different poll', () => {
            const forged = close(2, AUTHOR, {
                content: { kind: 'poll_close', close: { pollId: '64b000000000000000000999' } },
            });
            expect(tally([forged]).closed).toBeFalse();
        });

        it('a vote older than the poll itself', () => {
            expect(counts([vote(1, ALICE, [0], { id: '64b0000000000000000000ff' })])).toEqual([0, 0, 0]);
        });

        it('every vote when the poll was deleted', () => {
            const result = tally([vote(1, ALICE, [0])], { deleted: true });
            expect(result.totalVoters).toBe(0);
            expect(result.closed).toBeFalse();
        });

        it('malformed ids', () => {
            expect(counts([vote(1, ALICE, [0], { id: 'ZZZ' })])).toEqual([0, 0, 0]);
            expect(tally([vote(1, ALICE, [0])], { pollId: 'not-an-id' }).totalVoters).toBe(0);
        });

        it('control messages of other kinds', () => {
            const text: PollControl = { ...vote(1, ALICE, [0]), content: { kind: 'text' } };
            expect(counts([text])).toEqual([0, 0, 0]);
        });
    });

    describe('anonymity', () => {
        it('lists voters in a public poll', () => {
            const result = tally([vote(1, ALICE, [0]), vote(2, BOB, [0])]);
            expect(result.options[0].voterIds).toEqual([ALICE, BOB]);
        });

        it('carries no voter ids at all in an anonymous poll, yet still reports our own choice', () => {
            const result = tally([vote(1, ALICE, [1]), vote(2, BOB, [1])], {}, poll({ anonymous: true }));
            expect(result.options.every((o) => o.voterIds === null)).toBeTrue();
            expect(JSON.stringify(result)).not.toContain(BOB);
            expect(result.mine).toEqual([1]);
            expect(result.options[1].count).toBe(2);
        });
    });

    describe('an edited poll', () => {
        it('ignores votes cast before the edit', () => {
            const result = tally(
                [
                    vote(1, ALICE, [0], { createdAt: '2026-06-01T09:00:00Z' }),
                    vote(2, BOB, [1], { createdAt: '2026-06-01T10:30:00Z' }),
                ],
                { editedAt: '2026-06-01T10:00:00Z' }
            );
            expect(result.options.map((o) => o.count)).toEqual([0, 1, 0]);
        });

        it('does not let a pre-edit vote stand in for a missing post-edit one', () => {
            const result = tally([vote(1, ALICE, [0], { createdAt: '2026-06-01T09:00:00Z' })], {
                editedAt: '2026-06-01T10:00:00Z',
            });
            expect(result.totalVoters).toBe(0);
        });

        it('counts everything when the poll was never edited', () => {
            expect(counts([vote(1, ALICE, [0])], { editedAt: null })).toEqual([1, 0, 0]);
        });
    });

    describe('votes that could not be read', () => {
        it('are counted as unreadable, not as votes', () => {
            const result = tally([
                vote(1, ALICE, [0]),
                vote(2, BOB, [1], { trusted: false }),
                vote(3, AUTHOR, [1], { trusted: false }),
            ]);
            expect(result.unreadable).toBe(2);
            expect(result.totalVoters).toBe(1);
        });

        it('do not include controls filed under another poll', () => {
            expect(
                tally([vote(1, ALICE, [0], { trusted: false, pollMessageId: '64b000000000000000000999' })]).unreadable
            ).toBe(0);
        });
    });

    it('reports the current user selection', () => {
        expect(tally([vote(1, ALICE, [2])]).mine).toEqual([2]);
        expect(tally([vote(1, BOB, [2])]).mine).toEqual([]);
        expect(tally([vote(1, ALICE, [2])], { meId: null }).mine).toEqual([]);
    });
});
