import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { LucideAngularModule, ShieldAlert, X } from 'lucide-angular';

import { ChatExportService, ExportCancelledError, ExportProgress } from '../../../core/services/chat-export.service';
import { DismissOnEscapeDirective } from '../../../shared/ui/dismiss/dismiss-on-escape.directive';

type Phase = 'confirm' | 'running' | 'done' | 'cancelled' | 'error';

/**
 * Export the chat's history as JSON. Says up front that the file is decrypted, shows what is
 * happening while it works, and can be cancelled at any page boundary.
 */
@Component({
    selector: 'app-export-dialog',
    imports: [DismissOnEscapeDirective, LucideAngularModule],
    templateUrl: './export-dialog.component.html',
    styleUrl: './export-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExportDialogComponent {
    private readonly exporter = inject(ChatExportService);

    readonly chatId = input.required<string>();
    readonly closed = output<void>();

    readonly phase = signal<Phase>('confirm');
    readonly progress = signal<ExportProgress | null>(null);
    readonly savedCount = signal(0);
    readonly unreadableCount = signal(0);
    readonly incompletePolls = signal(0);
    readonly error = signal<string | null>(null);

    readonly closeIcon = X;
    readonly warnIcon = ShieldAlert;

    private controller: AbortController | null = null;

    constructor() {
        // Closing the dialog (or leaving the screen) stops the work rather than letting it run unseen.
        inject(DestroyRef).onDestroy(() => this.controller?.abort());
    }

    async start(): Promise<void> {
        if (this.phase() === 'running') {
            return;
        }
        this.controller = new AbortController();
        this.phase.set('running');
        this.error.set(null);
        this.progress.set({ phase: 'messages', done: 0, total: null });

        try {
            const result = await this.exporter.run(this.chatId(), (p) => this.progress.set(p), this.controller.signal);
            this.exporter.download(result.json, result.fileName);
            this.savedCount.set(result.messageCount);
            this.unreadableCount.set(result.unreadableCount);
            this.incompletePolls.set(result.incompletePolls);
            this.phase.set('done');
        } catch (error) {
            if (error instanceof ExportCancelledError || this.controller.signal.aborted) {
                this.phase.set('cancelled');
            } else {
                this.error.set('The history could not be exported. Nothing was saved.');
                this.phase.set('error');
            }
        }
    }

    cancel(): void {
        this.controller?.abort();
    }

    close(): void {
        this.controller?.abort();
        this.closed.emit();
    }
}
