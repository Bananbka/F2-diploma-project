import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { MessageResponse } from '../models/crypto.model';
import { ChatApiService } from './chat-api.service';
import { DecryptedMessage, DecryptStatus, MessageService } from './message.service';
import { PollStoreService } from './poll-store.service';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const POLL = '64b000000000000000000100';
const id = (n: number) => `64b0000000000000000002${n.toString(16).padStart(2, '0')}`;

function raw(n: number): MessageResponse {
    return { _id: id(n), chat_id: CHAT, is_control: true, poll_message_id: POLL } as MessageResponse;
}

function vote(n: number, options: number[], status: DecryptStatus = 'ok', verified = true): DecryptedMessage {
    return {
        id: id(n),
        chatId: CHAT,
        senderId: 'alice',
        createdAt: '2026-06-01T10:00:00Z',
        text: null,
        status,
        isEdited: false,
        replyToId: null,
        forwardedFrom: null,
        attachments: [],
        senderVerified: verified,
        reactions: [],
        isPinned: false,
        isControl: true,
        content: { kind: 'poll_vote', vote: { pollId: POLL, options } },
    };
}

describe('PollStoreService', () => {
    let polls: PollStoreService;
    let api: jasmine.SpyObj<ChatApiService>;
    let messages: jasmine.SpyObj<MessageService>;

    beforeEach(() => {
        api = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['getPollVotes']);
        messages = jasmine.createSpyObj<MessageService>('MessageService', ['decrypt', 'refreshGrants']);
        TestBed.configureTestingModule({
            providers: [
                PollStoreService,
                { provide: ChatApiService, useValue: api },
                { provide: MessageService, useValue: messages },
            ],
        });
        polls = TestBed.inject(PollStoreService);
    });

    it('pages through every vote and decrypts oldest first', async () => {
        // 100 per page: a full first page forces a second request.
        const newest = Array.from({ length: 100 }, (_, i) => raw(120 - i));
        const oldest = [raw(10), raw(9)];
        api.getPollVotes.and.returnValues(of(newest), of(oldest));
        const order: string[] = [];
        messages.decrypt.and.callFake(async (_chat, message) => {
            order.push(message._id);
            return vote(parseInt(message._id.slice(-2), 16), [0]);
        });

        await polls.ensureLoaded(CHAT, POLL);

        expect(api.getPollVotes.calls.argsFor(1)).toEqual([CHAT, POLL, 100, newest[99]._id]);
        expect(order).toEqual([...order].sort());
        expect(order.length).toBe(102);
        expect(polls.controls(POLL).length).toBe(102);
    });

    it('loads a poll only once', async () => {
        api.getPollVotes.and.returnValue(of([]));
        await polls.ensureLoaded(CHAT, POLL);
        await polls.ensureLoaded(CHAT, POLL);
        expect(api.getPollVotes).toHaveBeenCalledTimes(1);
    });

    it('reports a load failure instead of pretending there are no votes', async () => {
        api.getPollVotes.and.throwError('network');
        await polls.ensureLoaded(CHAT, POLL);
        expect(polls.state(POLL).error).toBeTrue();
    });

    it('only trusts a control that opened and verified', async () => {
        api.getPollVotes.and.returnValue(of([raw(3), raw(2), raw(1)]));
        messages.decrypt.and.callFake(async (_chat, message) => {
            if (message._id === id(1)) {
                return vote(1, [0]);
            }
            if (message._id === id(2)) {
                return vote(2, [0], 'failed');
            }
            return vote(3, [0], 'ok', false);
        });

        await polls.ensureLoaded(CHAT, POLL);

        expect(polls.controls(POLL).map((c) => c.trusted)).toEqual([true, false, false]);
    });

    it('adds a vote that arrives over the socket, once', async () => {
        messages.decrypt.and.resolveTo(vote(5, [1]));
        await polls.ingest(CHAT, raw(5));
        await polls.ingest(CHAT, raw(5));
        expect(polls.controls(POLL).length).toBe(1);
    });

    it('ignores a message that is not a control message', async () => {
        await polls.ingest(CHAT, { ...raw(5), is_control: false });
        await polls.ingest(CHAT, { ...raw(6), poll_message_id: 'not-an-id' });
        expect(messages.decrypt).not.toHaveBeenCalled();
    });

    describe('staying current', () => {
        it('reloads a held poll after the conversation changed', async () => {
            api.getPollVotes.and.returnValue(of([]));
            await polls.ensureLoaded(CHAT, POLL);
            await polls.ensureLoaded(CHAT, POLL);
            expect(api.getPollVotes).toHaveBeenCalledTimes(1);

            // Another chat was open for a while: votes may have been cast unseen.
            polls.markAllStale();
            expect(polls.state(POLL).stale).toBeTrue();
            await polls.ensureLoaded(CHAT, POLL);

            expect(api.getPollVotes).toHaveBeenCalledTimes(2);
            expect(polls.state(POLL).stale).toBeFalse();
        });

        it('picks up a vote cast while away', async () => {
            api.getPollVotes.and.returnValues(of([]), of([raw(1)]));
            messages.decrypt.and.resolveTo(vote(1, [0]));
            await polls.ensureLoaded(CHAT, POLL);
            expect(polls.controls(POLL).length).toBe(0);

            polls.markAllStale();
            await polls.ensureLoaded(CHAT, POLL);

            expect(polls.controls(POLL).length).toBe(1);
        });
    });

    describe('after a failed load', () => {
        it('is retryable by simply loading again', async () => {
            api.getPollVotes.and.returnValues(
                throwError(() => new Error('down')),
                of([raw(1)])
            );
            messages.decrypt.and.resolveTo(vote(1, [0]));

            await polls.ensureLoaded(CHAT, POLL);
            expect(polls.state(POLL).error).toBeTrue();
            expect(polls.state(POLL).requested).toBeFalse();

            await polls.ensureLoaded(CHAT, POLL);

            expect(polls.state(POLL).error).toBeFalse();
            expect(polls.controls(POLL).length).toBe(1);
        });

        it('is retryable with reload (the card button)', async () => {
            api.getPollVotes.and.returnValues(
                throwError(() => new Error('down')),
                of([])
            );
            await polls.ensureLoaded(CHAT, POLL);

            await polls.reload(CHAT, POLL);

            expect(polls.state(POLL).error).toBeFalse();
        });
    });

    describe('deleted control messages', () => {
        it('removes a deleted vote from its poll', async () => {
            messages.decrypt.and.callFake(async (_c, m) => vote(parseInt(m._id.slice(-2), 16), [0]));
            await polls.ingest(CHAT, raw(5));
            await polls.ingest(CHAT, raw(6));

            polls.removeControl(id(5));

            expect(polls.controls(POLL).map((c) => c.id)).toEqual([id(6)]);
        });

        it('ignores an id that is not a vote', async () => {
            messages.decrypt.and.resolveTo(vote(5, [0]));
            await polls.ingest(CHAT, raw(5));
            polls.removeControl('64b0000000000000000000ee');
            expect(polls.controls(POLL).length).toBe(1);
        });
    });

    describe('retrying votes that arrived before their key', () => {
        const CHAT_B = 'b0000000-0000-4000-8000-000000000002';
        const POLL_B = '64b000000000000000000200';

        afterEach(() => jasmine.clock().uninstall());

        it('decrypts each poll with its own chat, never another chat id', async () => {
            const rawA = raw(1);
            const rawB = { ...raw(2), chat_id: CHAT_B, poll_message_id: POLL_B };
            messages.refreshGrants.and.resolveTo(undefined);
            messages.decrypt.and.callFake(async (chat, message) => ({
                ...vote(parseInt(message._id.slice(-2), 16), [0], 'no_key'),
                chatId: chat,
            }));

            jasmine.clock().install();
            await polls.ingest(CHAT, rawA);
            await polls.ingest(CHAT_B, rawB);
            messages.decrypt.calls.reset();
            jasmine.clock().tick(1600);
            jasmine.clock().uninstall();
            await new Promise((resolve) => setTimeout(resolve, 30));

            const refreshed = messages.refreshGrants.calls.allArgs().map((args) => args[0]);
            expect(refreshed.sort()).toEqual([CHAT, CHAT_B].sort());

            for (const [chat, message] of messages.decrypt.calls.allArgs()) {
                expect(chat).toBe(message._id === rawA._id ? CHAT : CHAT_B);
            }
            expect(messages.decrypt).toHaveBeenCalledTimes(2);
        });
    });

    it('forgets a deleted poll', async () => {
        messages.decrypt.and.resolveTo(vote(5, [1]));
        await polls.ingest(CHAT, raw(5));
        polls.forget(POLL);
        expect(polls.controls(POLL)).toEqual([]);
    });

    it('never lets an unreadable re-read replace a control already opened', async () => {
        messages.decrypt.and.resolveTo(vote(5, [1]));
        await polls.ingest(CHAT, raw(5));
        messages.decrypt.and.resolveTo(vote(5, [1], 'failed'));
        await polls.ingest(CHAT, raw(5));
        expect(polls.controls(POLL)[0].trusted).toBeTrue();
    });
});
