import {
    ChangeDetectionStrategy,
    Component,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import { LucideAngularModule, Paperclip, RefreshCw, Send, ShieldAlert } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { MessageAttachment } from '../../../core/models/crypto.model';
import { ProfileApiService } from '../../../core/services/profile-api.service';

/** What the composer hands over. Attachments travel with the message, not separately. */
export interface ComposedMessage {
    text: string;
    attachments: MessageAttachment[];
}

@Component({
    selector: 'app-composer',
    imports: [LucideAngularModule],
    templateUrl: './composer.component.html',
    styleUrl: './composer.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerComponent {
    private readonly profileApi = inject(ProfileApiService);

    /** False while the member set cannot be verified — sending is refused, not merely discouraged. */
    readonly canSend = input(true);
    readonly blockedReason = input<string | null>(null);
    readonly rekeying = input(false);
    readonly placeholder = input('Message…');
    /** Pre-fills the box when an existing message is being edited. */
    readonly initialText = input('');

    readonly submitted = output<ComposedMessage>();
    readonly typing = output<boolean>();

    readonly text = signal('');
    readonly attachments = signal<MessageAttachment[]>([]);
    readonly uploading = signal(false);
    readonly uploadError = signal<string | null>(null);

    private readonly area = viewChild<ElementRef<HTMLTextAreaElement>>('area');
    private typingActive = false;
    private typingTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        // Only when it actually changes: writing on every render would fight the user's typing.
        effect(() => {
            const text = this.initialText();
            untracked(() => {
                this.text.set(text);
                const element = this.area()?.nativeElement;
                if (element) {
                    element.value = text;
                    element.focus();
                }
            });
        });
    }

    readonly sendIcon = Send;
    readonly paperclipIcon = Paperclip;
    readonly refreshIcon = RefreshCw;
    readonly shieldAlertIcon = ShieldAlert;

    onInput(value: string): void {
        this.text.set(value);
        this.autoGrow();
        this.pingTyping();
    }

    onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.send();
        }
    }

    /**
     * Upload a file so it can travel with the next message.
     *
     * Uploaded ahead of the send because the message references the object by URL. Note the server
     * reaps unreferenced blobs after 24 hours, so a file staged and never sent does not linger.
     */
    async onFilePicked(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) {
            return;
        }

        this.uploading.set(true);
        try {
            const uploaded = await firstValueFrom(this.profileApi.upload(file, 'message'));
            this.attachments.update((list) => [...list, uploaded]);
        } catch {
            this.uploadError.set('Could not upload that file.');
        } finally {
            this.uploading.set(false);
            input.value = '';
        }
    }

    removeAttachment(url: string): void {
        this.attachments.update((list) => list.filter((file) => file.url !== url));
    }

    send(): void {
        const value = this.text().trim();
        if ((!value && this.attachments().length === 0) || !this.canSend()) {
            return;
        }

        this.submitted.emit({ text: value, attachments: this.attachments() });
        this.text.set('');
        this.attachments.set([]);
        this.stopTyping();

        const element = this.area()?.nativeElement;
        if (element) {
            element.value = '';
            element.style.height = 'auto';
        }
    }

    private autoGrow(): void {
        const element = this.area()?.nativeElement;
        if (!element) {
            return;
        }

        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    }

    /** Debounced so a fast typist emits one start and one stop, not one event per keystroke. */
    private pingTyping(): void {
        if (!this.typingActive) {
            this.typingActive = true;
            this.typing.emit(true);
        }

        if (this.typingTimer) {
            clearTimeout(this.typingTimer);
        }
        this.typingTimer = setTimeout(() => this.stopTyping(), 2500);
    }

    private stopTyping(): void {
        if (this.typingTimer) {
            clearTimeout(this.typingTimer);
            this.typingTimer = null;
        }
        if (this.typingActive) {
            this.typingActive = false;
            this.typing.emit(false);
        }
    }
}
