import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { LucideAngularModule, Plus, Trash2, X } from 'lucide-angular';

import {
    ANONYMOUS_POLL_NOTE,
    PayloadValidationError,
    POLL_OPTION_MAX,
    POLL_OPTIONS_MAX,
    POLL_OPTIONS_MIN,
    POLL_QUESTION_MAX,
    PollPayload,
    validatePoll,
} from '../../../core/models/message-payload';

@Component({
    selector: 'app-poll-dialog',
    imports: [LucideAngularModule],
    templateUrl: './poll-dialog.component.html',
    styleUrl: './poll-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PollDialogComponent {
    /** Why sending is impossible right now, or null. Re-checked by the composer on submit too. */
    readonly blockedReason = input<string | null>(null);

    readonly submitted = output<PollPayload>();
    readonly closed = output<void>();

    readonly question = signal('');
    readonly options = signal<string[]>(['', '']);
    readonly multiple = signal(false);
    readonly anonymous = signal(false);

    readonly questionMax = POLL_QUESTION_MAX;
    readonly optionMax = POLL_OPTION_MAX;
    readonly anonymousNote = ANONYMOUS_POLL_NOTE;
    readonly closeIcon = X;
    readonly plusIcon = Plus;
    readonly trashIcon = Trash2;

    readonly canAddOption = computed(() => this.options().length < POLL_OPTIONS_MAX);
    readonly canRemoveOption = computed(() => this.options().length > POLL_OPTIONS_MIN);

    /** The validated poll, or the reason it is not valid yet. Duplicate options are refused here. */
    private readonly checked = computed<{ poll: PollPayload } | { error: string }>(() => {
        try {
            const poll = validatePoll({
                question: this.question(),
                options: this.options(),
                multiple: this.multiple(),
                anonymous: this.anonymous(),
                closesAt: null,
            });
            const lowered = poll.options.map((option) => option.toLowerCase());
            if (new Set(lowered).size !== lowered.length) {
                return { error: 'Options must be different from each other.' };
            }
            return { poll };
        } catch (error) {
            return { error: error instanceof PayloadValidationError ? error.message : 'Invalid poll.' };
        }
    });

    readonly problem = computed(() => {
        const result = this.checked();
        return 'error' in result ? result.error : null;
    });

    readonly canSubmit = computed(() => this.problem() === null && !this.blockedReason());

    setOption(index: number, value: string): void {
        this.options.update((list) => list.map((option, i) => (i === index ? value : option)));
    }

    addOption(): void {
        if (this.canAddOption()) {
            this.options.update((list) => [...list, '']);
        }
    }

    removeOption(index: number): void {
        if (this.canRemoveOption()) {
            this.options.update((list) => list.filter((_, i) => i !== index));
        }
    }

    submit(): void {
        const result = this.checked();
        if ('poll' in result && this.canSubmit()) {
            this.submitted.emit(result.poll);
        }
    }
}
