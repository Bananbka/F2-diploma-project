import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Check, Circle, CircleDot, LucideAngularModule, Square, SquareCheck } from 'lucide-angular';

import { ANONYMOUS_POLL_NOTE } from '../../../core/models/message-payload';
import { PollOptionTally, tallyPoll } from '../../../core/polls/poll-tally';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { contentOf, DecryptedMessage } from '../../../core/services/message.service';
import { PollStoreService } from '../../../core/services/poll-store.service';
import { SessionService } from '../../../core/services/session.service';

/** Voter names listed under an option before collapsing into "+N". */
const VISIBLE_VOTERS = 4;
/** `setTimeout` overflows beyond this and fires immediately. */
const MAX_TIMER_MS = 2_147_000_000;

/**
 * A poll inside a message bubble.
 *
 * Everything shown is derived: the poll definition comes from the decrypted message, the counts from
 * `tallyPoll` over the control messages `PollStoreService` holds. An anonymous poll's tally carries
 * no voter ids at all, so this template cannot show who voted even by mistake - and says plainly
 * that the anonymity is a property of this interface, not of the protocol.
 */
@Component({
    selector: 'app-poll-card',
    imports: [LucideAngularModule],
    templateUrl: './poll-card.component.html',
    styleUrl: './poll-card.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PollCardComponent {
    private readonly store = inject(ChatStoreService);
    private readonly polls = inject(PollStoreService);
    private readonly directory = inject(DirectoryService);
    private readonly session = inject(SessionService);

    readonly message = input.required<DecryptedMessage>();

    /** A message still being sent has no server id, so there is nothing to vote on yet. */
    readonly isLocal = computed(() => this.message().id.startsWith('local-'));

    readonly poll = computed(() => {
        const content = contentOf(this.message());
        return content.kind === 'poll' ? content.poll : null;
    });

    private readonly now = signal(new Date());
    readonly busy = signal(false);
    readonly error = signal<string | null>(null);
    readonly confirmingClose = signal(false);
    /** A multiple-choice selection not yet sent. `null` follows what the tally says is ours. */
    private readonly draft = signal<number[] | null>(null);

    readonly isAuthor = computed(() => this.directory.isMe(this.message().senderId));

    readonly anonymousNote = ANONYMOUS_POLL_NOTE;

    private readonly heldControls = computed(() => (this.isLocal() ? [] : this.polls.controls(this.message().id)));

    /**
     * The clock used for "is it closed yet". A device clock running behind would show a poll as open
     * after the server has already stamped later messages, so the newest server timestamp we have
     * seen is a floor. Display only: which votes count is decided from server timestamps alone.
     */
    private readonly effectiveNow = computed(() => {
        let floor = Date.parse(this.message().createdAt);
        for (const control of this.heldControls()) {
            floor = Math.max(floor, Date.parse(control.createdAt) || 0);
        }
        return new Date(Math.max(this.now().getTime(), Number.isNaN(floor) ? 0 : floor));
    });

    readonly tally = computed(() => {
        const poll = this.poll();
        if (!poll) {
            return null;
        }
        const message = this.message();
        const participants = this.store.activeChat()?.participants ?? [];
        return tallyPoll({
            pollId: message.id,
            authorId: message.senderId,
            poll,
            controls: this.heldControls(),
            editedAt: message.isEdited ? message.editedAt : null,
            // An empty roster means "not loaded", not "nobody is a member".
            memberIds: participants.length > 0 ? new Set(participants.map((p) => p.user_id)) : null,
            now: this.effectiveNow(),
            meId: this.session.user()?.id ?? null,
        });
    });

    readonly loading = computed(() => !this.isLocal() && this.polls.state(this.message().id).loading);
    readonly loadFailed = computed(() => !this.isLocal() && this.polls.state(this.message().id).error);
    readonly truncated = computed(() => !this.isLocal() && this.polls.state(this.message().id).truncated);

    readonly selection = computed(() => this.draft() ?? this.tally()?.mine ?? []);
    readonly dirty = computed(() => {
        const draft = this.draft();
        const mine = this.tally()?.mine ?? [];
        return draft !== null && draft.length > 0 && draft.join() !== [...mine].sort((a, b) => a - b).join();
    });

    readonly canVote = computed(() => !this.isLocal() && !this.tally()?.closed && !this.busy() && this.store.canSend());
    readonly canClose = computed(
        () => this.isAuthor() && !this.isLocal() && !this.tally()?.closed && !this.busy() && this.store.canSend()
    );

    readonly checkIcon = Check;
    readonly squareIcon = Square;
    readonly checkSquareIcon = SquareCheck;
    readonly circleIcon = Circle;
    readonly circleDotIcon = CircleDot;

    constructor() {
        // Load the votes the first time this bubble renders.
        effect(() => {
            const message = this.message();
            const isPoll = this.poll() !== null;
            untracked(() => {
                if (isPoll && !message.id.startsWith('local-')) {
                    void this.polls.ensureLoaded(message.chatId, message.id);
                }
            });
        });

        // Flip to "closed" when a deadline passes while the poll is on screen.
        effect((onCleanup) => {
            const closesAt = this.poll()?.closesAt;
            if (!closesAt) {
                return;
            }
            const delay = Date.parse(closesAt) - Date.now();
            if (delay <= 0 || delay > MAX_TIMER_MS) {
                return;
            }
            const timer = setTimeout(() => this.now.set(new Date()), delay + 50);
            onCleanup(() => clearTimeout(timer));
        });
    }

    /** Try the vote fetch again after a failure. */
    retryLoad(): void {
        const message = this.message();
        if (!this.isLocal()) {
            void this.polls.reload(message.chatId, message.id);
        }
    }

    isSelected(index: number): boolean {
        return this.selection().includes(index);
    }

    voterNames(option: PollOptionTally): { shown: string[]; more: number } {
        const ids = option.voterIds ?? [];
        return {
            shown: ids.slice(0, VISIBLE_VOTERS).map((id) => this.directory.lookup(id).name),
            more: Math.max(0, ids.length - VISIBLE_VOTERS),
        };
    }

    async choose(index: number): Promise<void> {
        const poll = this.poll();
        if (!poll || !this.canVote()) {
            return;
        }
        this.error.set(null);

        if (poll.multiple) {
            const current = this.selection();
            const next = current.includes(index) ? current.filter((i) => i !== index) : [...current, index];
            this.draft.set(next.sort((a, b) => a - b));
            return;
        }

        if (this.tally()?.mine.length === 1 && this.tally()?.mine[0] === index) {
            return;
        }
        await this.submit([index]);
    }

    async submitDraft(): Promise<void> {
        const draft = this.draft();
        if (draft && draft.length > 0 && this.canVote()) {
            await this.submit(draft);
        }
    }

    private async submit(options: number[]): Promise<void> {
        this.busy.set(true);
        try {
            await this.store.votePoll(this.message().id, options);
            this.draft.set(null);
        } catch {
            this.error.set('Your vote could not be sent. Try again.');
        } finally {
            this.busy.set(false);
        }
    }

    askClose(): void {
        if (this.canClose()) {
            this.confirmingClose.set(true);
        }
    }

    cancelClose(): void {
        this.confirmingClose.set(false);
    }

    async confirmClose(): Promise<void> {
        if (!this.canClose()) {
            return;
        }
        this.busy.set(true);
        this.error.set(null);
        try {
            await this.store.closePoll(this.message().id);
            this.confirmingClose.set(false);
        } catch {
            this.error.set('The poll could not be closed. Try again.');
        } finally {
            this.busy.set(false);
        }
    }
}
