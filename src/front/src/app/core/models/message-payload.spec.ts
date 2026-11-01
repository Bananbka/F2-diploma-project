import {
    classifyPlaintext,
    encodeTypedPayload,
    formatCoordinates,
    LOCATION_LABEL_MAX,
    openStreetMapUrl,
    PollPayload,
    summarizeContent,
    validateLocation,
    validatePoll,
    validateVote,
} from './message-payload';

const POLL_ID = '64b0000000000000000000a0';

function poll(overrides: Partial<PollPayload> = {}): PollPayload {
    return {
        question: 'Lunch?',
        options: ['Pizza', 'Sushi'],
        multiple: false,
        anonymous: false,
        closesAt: null,
        ...overrides,
    };
}

describe('message payloads', () => {
    describe('validatePoll', () => {
        it('trims the question and options', () => {
            const valid = validatePoll(poll({ question: '  Lunch?  ', options: [' a ', 'b '] }));
            expect(valid.question).toBe('Lunch?');
            expect(valid.options).toEqual(['a', 'b']);
        });

        it('accepts the boundaries: 300-char question, 100-char options, 2 and 10 options', () => {
            expect(() => validatePoll(poll({ question: 'q'.repeat(300) }))).not.toThrow();
            expect(() => validatePoll(poll({ options: ['a'.repeat(100), 'b'] }))).not.toThrow();
            expect(() => validatePoll(poll({ options: Array.from({ length: 10 }, (_, i) => `o${i}`) }))).not.toThrow();
        });

        it('bounds the option count before looking at any option', () => {
            const hostile = new Proxy(new Array(1_000_000), {
                get(target, key, receiver) {
                    if (key === 'map' || key === 'some' || key === 'every') {
                        throw new Error('iterated a hostile array');
                    }
                    return Reflect.get(target, key, receiver);
                },
            });
            expect(() => validatePoll(poll({ options: hostile as unknown as string[] }))).toThrowError(/options/);
        });

        it('rejects what is out of bounds', () => {
            expect(() => validatePoll(poll({ question: '   ' }))).toThrow();
            expect(() => validatePoll(poll({ question: 'q'.repeat(301) }))).toThrow();
            expect(() => validatePoll(poll({ options: ['only one'] }))).toThrow();
            expect(() => validatePoll(poll({ options: Array.from({ length: 11 }, (_, i) => `o${i}`) }))).toThrow();
            expect(() => validatePoll(poll({ options: ['a', ''] }))).toThrow();
            expect(() => validatePoll(poll({ options: ['a'.repeat(101), 'b'] }))).toThrow();
        });

        it('rejects non-boolean flags and a bad closing time', () => {
            expect(() => validatePoll(poll({ multiple: 'yes' as never }))).toThrow();
            expect(() => validatePoll(poll({ closesAt: 'not a date' }))).toThrow();
        });
    });

    describe('validateVote', () => {
        it('accepts distinct in-range indices and sorts them', () => {
            expect(validateVote({ pollId: POLL_ID, options: [3, 1] }).options).toEqual([1, 3]);
        });

        it('rejects malformed votes', () => {
            expect(() => validateVote({ pollId: 'nope', options: [0] })).toThrow();
            expect(() => validateVote({ pollId: POLL_ID, options: [] })).toThrow();
            expect(() => validateVote({ pollId: POLL_ID, options: [1, 1] })).toThrow();
            expect(() => validateVote({ pollId: POLL_ID, options: [-1] })).toThrow();
            expect(() => validateVote({ pollId: POLL_ID, options: [1.5] })).toThrow();
            expect(() => validateVote({ pollId: POLL_ID, options: [10] })).toThrow();
            expect(() => validateVote({ pollId: POLL_ID, options: [Number.NaN] })).toThrow();
        });
    });

    describe('validateLocation', () => {
        it('accepts the extremes', () => {
            expect(() => validateLocation({ lat: 90, lon: 180, accuracy: 0, label: null })).not.toThrow();
            expect(() => validateLocation({ lat: -90, lon: -180, accuracy: null, label: null })).not.toThrow();
        });

        it('rejects out-of-range, NaN and infinite coordinates', () => {
            for (const [lat, lon] of [
                [90.0001, 0],
                [0, 180.5],
                [Number.NaN, 0],
                [0, Number.POSITIVE_INFINITY],
            ]) {
                expect(() => validateLocation({ lat, lon, accuracy: null, label: null })).toThrow();
            }
            expect(() => validateLocation({ lat: '1' as never, lon: 0, accuracy: null, label: null })).toThrow();
        });

        it('rounds coordinates to six decimals', () => {
            const rounded = validateLocation({ lat: 50.4501234567, lon: -30.5234567891, accuracy: null, label: null });
            expect(rounded.lat).toBe(50.450123);
            expect(rounded.lon).toBe(-30.523457);
            expect(String(validateLocation({ lat: 1e-9, lon: 0, accuracy: null, label: null }).lat)).not.toContain('e');
        });

        it('rejects a negative or non-finite accuracy', () => {
            expect(() => validateLocation({ lat: 0, lon: 0, accuracy: -1, label: null })).toThrow();
            expect(() => validateLocation({ lat: 0, lon: 0, accuracy: Number.NaN, label: null })).toThrow();
        });

        it('clamps the label rather than rejecting it, and drops a blank one', () => {
            const long = validateLocation({ lat: 0, lon: 0, accuracy: null, label: 'x'.repeat(500) });
            expect(long.label!.length).toBe(LOCATION_LABEL_MAX);
            expect(validateLocation({ lat: 0, lon: 0, accuracy: null, label: '   ' }).label).toBeNull();
        });
    });

    describe('wire format', () => {
        it('round-trips a poll through encode and classify', () => {
            const encoded = encodeTypedPayload({ kind: 'poll', poll: poll({ closesAt: '2030-01-01T00:00:00.000Z' }) });
            const { content } = classifyPlaintext(JSON.parse(JSON.stringify(encoded)), false);
            expect(content).toEqual({ kind: 'poll', poll: poll({ closesAt: '2030-01-01T00:00:00.000Z' }) });
        });

        it('round-trips a vote and a close as control messages', () => {
            const vote = JSON.parse(
                JSON.stringify(encodeTypedPayload({ kind: 'poll_vote', vote: { pollId: POLL_ID, options: [1] } }))
            );
            expect(classifyPlaintext(vote, true).content).toEqual({
                kind: 'poll_vote',
                vote: { pollId: POLL_ID, options: [1] },
            });

            const close = JSON.parse(
                JSON.stringify(encodeTypedPayload({ kind: 'poll_close', close: { pollId: POLL_ID } }))
            );
            expect(classifyPlaintext(close, true).content.kind).toBe('poll_close');
        });

        it('round-trips a location at six decimals', () => {
            const location = { lat: 50.450123, lon: 30.523457, accuracy: 12.5, label: 'Home' };
            const wire = JSON.parse(JSON.stringify(encodeTypedPayload({ kind: 'location', location })));
            expect(classifyPlaintext(wire, false).content).toEqual({ kind: 'location', location });
        });

        it('refuses to encode an invalid payload', () => {
            expect(() => encodeTypedPayload({ kind: 'poll', poll: poll({ options: ['a'] }) })).toThrow();
            expect(() =>
                encodeTypedPayload({ kind: 'location', location: { lat: 91, lon: 0, accuracy: null, label: null } })
            ).toThrow();
        });

        it('carries a readable fallback text for older clients', () => {
            expect(encodeTypedPayload({ kind: 'poll', poll: poll() })['text']).toBe('Poll: Lunch?');
        });

        it('treats untyped JSON as ordinary text', () => {
            expect(classifyPlaintext({ text: 'hi', attachmentKeys: [] }, false).content.kind).toBe('text');
            // A bare "type" without a version belongs to some other JSON that happened to be sent.
            expect(classifyPlaintext({ type: 'poll', text: 'x', attachmentKeys: [] }, false).content.kind).toBe('text');
        });

        it('shows an unknown type as unsupported, not as text', () => {
            const result = classifyPlaintext({ v: 1, type: 'hologram', text: 'hello', attachmentKeys: [] }, false);
            expect(result.content).toEqual({ kind: 'unsupported', reason: 'unknown_type', type: 'hologram' });
        });

        it('shows a newer version as unsupported', () => {
            const result = classifyPlaintext({ v: 2, type: 'poll', text: '', attachmentKeys: [] }, false);
            expect(result.content).toEqual({ kind: 'unsupported', reason: 'newer_version', type: 'poll' });
        });

        it('shows a malformed or oversized body as unsupported', () => {
            const bad = (body: unknown) =>
                classifyPlaintext({ v: 1, type: 'poll', text: '', attachmentKeys: [], poll: body }, false).content;
            expect(bad({ question: 'q'.repeat(301), options: ['a', 'b'], multiple: false, anonymous: false })).toEqual({
                kind: 'unsupported',
                reason: 'malformed',
                type: 'poll',
            });
            expect(bad('nope').kind).toBe('unsupported');
            expect(bad(null).kind).toBe('unsupported');
            expect(
                classifyPlaintext(
                    { v: 1, type: 'location', text: '', attachmentKeys: [], location: { lat: 'x', lon: 0 } },
                    false
                ).content.kind
            ).toBe('unsupported');
        });

        it('flags a vote sent as an ordinary message, and ordinary content sent as control, as misplaced', () => {
            const vote = encodeTypedPayload({ kind: 'poll_vote', vote: { pollId: POLL_ID, options: [0] } });
            expect(classifyPlaintext(JSON.parse(JSON.stringify(vote)), false).content).toEqual({
                kind: 'unsupported',
                reason: 'misplaced',
                type: 'poll_vote',
            });

            const asPoll = encodeTypedPayload({ kind: 'poll', poll: poll() });
            expect(classifyPlaintext(JSON.parse(JSON.stringify(asPoll)), true).content.kind).toBe('unsupported');
            expect(classifyPlaintext({ text: 'hi', attachmentKeys: [] }, true).content.kind).toBe('unsupported');
        });
    });

    describe('display helpers', () => {
        it('rounds coordinates for display only', () => {
            expect(formatCoordinates(50.4501234567, 30.5234567891)).toBe('50.45012, 30.52346');
        });

        it('builds an OpenStreetMap link with six decimals, never an exponent, and none for bad input', () => {
            expect(openStreetMapUrl(50.45, 30.52)).toBe(
                'https://www.openstreetmap.org/?mlat=50.450000&mlon=30.520000#map=16/50.450000/30.520000'
            );
            expect(openStreetMapUrl(0.0000001, -0.00000049)).not.toMatch(/e[-+]?\d/i);
            expect(openStreetMapUrl(0.0000001, 1e-9)).toContain('mlat=0.000000&mlon=0.000000');
            expect(openStreetMapUrl(100, 0)).toBeNull();
            expect(openStreetMapUrl(0, Number.NaN)).toBeNull();
        });

        it('summarises typed content for previews', () => {
            expect(summarizeContent({ kind: 'text' })).toBeNull();
            expect(summarizeContent({ kind: 'poll', poll: poll() })).toBe('Poll: Lunch?');
            expect(
                summarizeContent({ kind: 'location', location: { lat: 1, lon: 1, accuracy: null, label: 'Cafe' } })
            ).toBe('Location: Cafe');
            expect(summarizeContent({ kind: 'unsupported', reason: 'malformed', type: null })).toBe(
                'Unsupported message'
            );
        });
    });
});
