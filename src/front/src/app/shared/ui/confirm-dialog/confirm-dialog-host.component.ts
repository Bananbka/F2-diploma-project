import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    ElementRef,
    inject,
    input,
    output,
    viewChild,
} from '@angular/core';

import { ConfirmRequest, ConfirmService } from './confirm.service';

/** One question. A fresh instance per question, so it takes focus every time it appears. */
@Component({
    selector: 'app-confirm-dialog',
    templateUrl: './confirm-dialog-host.component.html',
    styleUrl: './confirm-dialog-host.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialogComponent {
    readonly request = input.required<ConfirmRequest>();
    readonly answered = output<boolean>();

    private readonly cancel = viewChild.required<ElementRef<HTMLButtonElement>>('cancel');

    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    constructor() {
        // Capture phase on the document, ahead of every other overlay's own key handling. The dialog
        // is modal, so it is by definition the topmost: Escape answers it and goes no further (a
        // sticker dialog underneath must not also close), and Tab never leaves it.
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.answered.emit(false);
            } else if (event.key === 'Tab') {
                event.preventDefault();
                const buttons = [...this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button')];
                const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const step = event.shiftKey ? -1 : 1;
                buttons[(at + step + buttons.length) % buttons.length]?.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', onKeyDown, true));

        // Safe default: Cancel takes focus, so a stray Enter never confirms a destructive action.
        afterNextRender(() => this.cancel().nativeElement.focus());
    }
}

/** Mounted once in the app root; shows whatever `ConfirmService` is asking. */
@Component({
    selector: 'app-confirm-dialog-host',
    imports: [ConfirmDialogComponent],
    template: `
        @for (question of open(); track question.id) {
            <app-confirm-dialog
                [request]="question"
                (answered)="service.answer($event)"
            />
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialogHostComponent {
    protected readonly service = inject(ConfirmService);

    protected readonly open = computed(() => {
        const pending = this.service.pending();
        return pending ? [pending] : [];
    });
}
