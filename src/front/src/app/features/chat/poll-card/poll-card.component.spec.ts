import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PollPayload } from '../../../core/models/message-payload';
import { PollControl } from '../../../core/polls/poll-tally';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { DecryptedMessage } from '../../../core/services/message.service';
import { PollStoreService } from '../../../core/services/poll-store.service';
import { SessionService } from '../../../core/services/session.service';
import { PollCardComponent } from './poll-card.component';

const POLL_ID = '64b000000000000000000100';
const ME = 'me';
const OTHER = 'other';

function pollMessage(poll: Partial<PollPayload> = {}, overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: POLL_ID,
        chatId: 'chat',
        senderId: OTHER,
        createdAt: '2026-06-01T10:00:00Z',
        text: null,
        status: 'ok',
        isEdited: false,
        replyToId: null,
        forwardedFrom: null,
        attachments: [],
        senderVerified: true,
        reactions: [],
        isPinned: false,
        content: {
            kind: 'poll',
            poll: {
                question: 'Lunch?',
                options: ['Pizza', 'Sushi'],
                multiple: false,
                anonymous: false,
                closesAt: null,
                ...poll,
            },
        },
        ...overrides,
    };
}

function vote(n: number, sender: string, options: number[]): PollControl {
    return {
        id: `64b00000000000000000020${n}`,
        senderId: sender,
        createdAt: '2026-06-01T10:05:00Z',
        pollMessageId: POLL_ID,
        trusted: true,
        content: { kind: 'poll_vote', vote: { pollId: POLL_ID, options } },
    };
}

describe('PollCardComponent', () => {
    let fixture: ComponentFixture<PollCardComponent>;
    let store: { activeChat: () => unknown; canSend: () => boolean; votePoll: jasmine.Spy; closePoll: jasmine.Spy };
    let polls: { controls: jasmine.Spy; state: jasmine.Spy; ensureLoaded: jasmine.Spy; reload: jasmine.Spy };
    const controls = signal<PollControl[]>([]);

    function create(message: DecryptedMessage): HTMLElement {
        fixture = TestBed.createComponent(PollCardComponent);
        fixture.componentRef.setInput('message', message);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(() => {
        controls.set([]);
        store = {
            activeChat: () => ({
                participants: [{ user_id: ME }, { user_id: OTHER }, { user_id: 'third' }],
            }),
            canSend: () => true,
            votePoll: jasmine.createSpy('votePoll').and.resolveTo(undefined),
            closePoll: jasmine.createSpy('closePoll').and.resolveTo(undefined),
        };
        polls = {
            controls: jasmine.createSpy('controls').and.callFake(() => controls()),
            state: jasmine.createSpy('state').and.returnValue({ loading: false, error: false, truncated: false }),
            ensureLoaded: jasmine.createSpy('ensureLoaded').and.resolveTo(undefined),
            reload: jasmine.createSpy('reload').and.resolveTo(undefined),
        };

        TestBed.configureTestingModule({
            imports: [PollCardComponent],
            providers: [
                { provide: ChatStoreService, useValue: store },
                { provide: PollStoreService, useValue: polls },
                {
                    provide: DirectoryService,
                    useValue: { isMe: (id: string) => id === ME, lookup: (id: string) => ({ name: `name-${id}` }) },
                },
                { provide: SessionService, useValue: { user: () => ({ id: ME }) } },
            ],
        });
    });

    it('renders the question, options and live counts', () => {
        controls.set([vote(1, ME, [0]), vote(2, 'third', [0])]);
        const host = create(pollMessage());

        expect(host.querySelector('.question')!.textContent).toContain('Lunch?');
        const figures = Array.from(host.querySelectorAll('.figures')).map((el) => el.textContent!.trim());
        expect(figures).toEqual(['100% · 2', '0% · 0']);
        expect(host.querySelector('.summary')!.textContent).toContain('2 voters');
    });

    it('loads the votes once when it first renders', () => {
        create(pollMessage());
        expect(polls.ensureLoaded).toHaveBeenCalledOnceWith('chat', POLL_ID);
    });

    it('names the voters of a public poll', () => {
        controls.set([vote(1, 'third', [1])]);
        const host = create(pollMessage());
        expect(host.querySelector('.voters')!.textContent).toContain('name-third');
    });

    it('shows counts only, and the honest note, for an anonymous poll', () => {
        controls.set([vote(1, 'third', [1])]);
        const host = create(pollMessage({ anonymous: true }));

        expect(host.querySelector('.voters')).toBeNull();
        expect(host.textContent).not.toContain('name-third');
        expect(host.textContent!.replace(/\s+/g, ' ')).toContain(
            "Anonymous only in the interface: the server knows who voted, and other members' browsers can see it too. This app merely hides it."
        );
        expect(host.querySelectorAll('.figures')[1].textContent).toContain('100%');
    });

    it('shows the anonymity note next to the label, before the options', () => {
        const host = create(pollMessage({ anonymous: true }));
        const kind = host.querySelector('.kind')!;
        const note = host.querySelector('.note')!;
        const options = host.querySelector('.options')!;
        expect(kind.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(note.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('says how many votes could not be read', () => {
        controls.set([
            { ...vote(1, 'third', [0]), trusted: false },
            { ...vote(2, 'third', [1]), trusted: false },
        ]);
        const host = create(pollMessage());
        expect(host.querySelector('.unreadable-note')!.textContent).toContain('2 votes could not be read');
        expect(host.querySelector('.summary')!.textContent).toContain('0 voters');
    });

    it('warns plainly that a truncated result may be incomplete', () => {
        polls.state.and.returnValue({ loading: false, error: false, truncated: true });
        const host = create(pollMessage());
        expect(host.querySelector('.truncated-banner')!.textContent).toContain('Result may be incomplete');
    });

    it('offers Retry after a failed load, and reloads on press', () => {
        polls.state.and.returnValue({ loading: false, error: true, truncated: false });
        const host = create(pollMessage());

        (host.querySelector('.retry-load') as HTMLButtonElement).click();

        expect(polls.reload).toHaveBeenCalledOnceWith('chat', POLL_ID);
    });

    it('marks an edited poll and does not count votes from before the edit', () => {
        controls.set([{ ...vote(1, 'third', [0]), createdAt: '2026-06-01T09:00:00Z' }, vote(2, OTHER, [1])]);
        const host = create(
            pollMessage({}, { isEdited: true, editedAt: '2026-06-01T10:00:00Z', createdAt: '2026-06-01T08:00:00Z' })
        );

        expect(host.querySelector('.edited-note')!.textContent).toContain('edited this poll');
        const figures = Array.from(host.querySelectorAll('.figures')).map((el) => el.textContent!.trim());
        expect(figures).toEqual(['0% · 0', '100% · 1']);
    });

    it('uses the newest server timestamp as a floor when the device clock is behind', () => {
        // A deadline in the past by server time, though the (mocked) device clock would not know.
        controls.set([{ ...vote(1, OTHER, [0]), createdAt: '2999-01-01T00:00:00Z' }]);
        const host = create(pollMessage({ closesAt: '2998-12-31T00:00:00Z' }));
        expect(host.textContent).toContain('time is up');
    });

    it('sends a vote on click in a single-choice poll', async () => {
        const host = create(pollMessage());
        (host.querySelectorAll('.option')[1] as HTMLButtonElement).click();
        await fixture.whenStable();
        expect(store.votePoll).toHaveBeenCalledOnceWith(POLL_ID, [1]);
    });

    it('does not re-send the vote that is already ours', async () => {
        controls.set([vote(1, ME, [1])]);
        const host = create(pollMessage());
        (host.querySelectorAll('.option')[1] as HTMLButtonElement).click();
        await fixture.whenStable();
        expect(store.votePoll).not.toHaveBeenCalled();
    });

    it('collects a multiple-choice selection and sends it with Vote', async () => {
        const host = create(pollMessage({ multiple: true, options: ['a', 'b', 'c'] }));
        (host.querySelectorAll('.option')[0] as HTMLButtonElement).click();
        (host.querySelectorAll('.option')[2] as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(store.votePoll).not.toHaveBeenCalled();

        (host.querySelector('.action.is-primary') as HTMLButtonElement).click();
        await fixture.whenStable();
        expect(store.votePoll).toHaveBeenCalledOnceWith(POLL_ID, [0, 2]);
    });

    it('shows a failed vote instead of pretending it counted', async () => {
        store.votePoll.and.rejectWith(new Error('nope'));
        const host = create(pollMessage());
        (host.querySelectorAll('.option')[0] as HTMLButtonElement).click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(host.querySelector('.note.is-danger')!.textContent).toContain('could not be sent');
    });

    describe('closing', () => {
        it('offers Close only to the author', () => {
            const asOther = create(pollMessage());
            expect(
                Array.from(asOther.querySelectorAll('.action')).some((b) => b.textContent!.includes('Close poll'))
            ).toBeFalse();
        });

        it('the author confirms before the close is sent', async () => {
            const host = create(pollMessage({}, { senderId: ME }));
            const press = (label: string) =>
                (
                    Array.from(host.querySelectorAll('button.action')).find((b) =>
                        b.textContent!.includes(label)
                    ) as HTMLButtonElement
                ).click();

            press('Close poll');
            fixture.detectChanges();
            expect(store.closePoll).not.toHaveBeenCalled();

            press('Close poll');
            await fixture.whenStable();
            expect(store.closePoll).toHaveBeenCalledOnceWith(POLL_ID);
        });

        it('disables voting once closed', () => {
            controls.set([
                {
                    id: '64b000000000000000000209',
                    senderId: OTHER,
                    createdAt: '2026-06-01T11:00:00Z',
                    pollMessageId: POLL_ID,
                    trusted: true,
                    content: { kind: 'poll_close', close: { pollId: POLL_ID } },
                },
            ]);
            const host = create(pollMessage());
            expect(host.textContent).toContain('Closed');
            expect((host.querySelector('.option') as HTMLButtonElement).disabled).toBeTrue();
        });
    });

    it('is inert while the poll is still being sent', () => {
        const host = create(pollMessage({}, { id: 'local-123' }));
        expect(polls.ensureLoaded).not.toHaveBeenCalled();
        expect((host.querySelector('.option') as HTMLButtonElement).disabled).toBeTrue();
    });

    it('cannot vote while sending is blocked', () => {
        store.canSend = () => false;
        const host = create(pollMessage());
        expect((host.querySelector('.option') as HTMLButtonElement).disabled).toBeTrue();
    });
});
