import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import { Film, LucideAngularModule, Paperclip, RefreshCw, Send, ShieldAlert, X } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { encryptAttachment } from '../../../core/crypto/attachment-crypto';
import { AttachmentKind, MessageAttachment } from '../../../core/models/crypto.model';
import { ProfileApiService } from '../../../core/services/profile-api.service';

/** What the composer hands over. Attachments travel with the message, not separately. */
export interface ComposedMessage {
    text: string;
    attachments: MessageAttachment[];
}

/** A staged attachment plus the local-only preview url, kept apart from the wire shape. */
interface StagedAttachment {
    file: MessageAttachment;
    /** `URL.createObjectURL` on the *original*, unencrypted bytes — revoked on removal/destroy. */
    previewUrl: string | null;
}

function inferKind(mimeType: string): AttachmentKind {
    if (mimeType === 'image/gif') {
        return 'gif';
    }
    if (mimeType.startsWith('image/')) {
        return 'image';
    }
    if (mimeType.startsWith('video/')) {
        return 'video';
    }
    if (mimeType.startsWith('audio/')) {
        return 'audio';
    }
    return 'file';
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
    private readonly destroyRef = inject(DestroyRef);

    /** False while the member set cannot be verified — sending is refused, not merely discouraged. */
    readonly canSend = input(true);
    readonly blockedReason = input<string | null>(null);
    readonly rekeying = input(false);
    readonly placeholder = input('Message…');
    /** Pre-fills the box when an existing message is being edited. */
    readonly initialText = input('');
    /**
     * Pre-populates the staged list when editing an existing message. `PUT /messages/{id}` now
     * accepts an `attachments` field, so these behave exactly like freshly staged attachments:
     * removable, and more can be added alongside them before the edit is submitted.
     */
    readonly initialAttachments = input<MessageAttachment[]>([]);
    readonly editing = input(false);

    readonly submitted = output<ComposedMessage>();
    readonly typing = output<boolean>();

    readonly text = signal('');
    readonly staged = signal<StagedAttachment[]>([]);
    readonly uploading = signal(false);
    readonly uploadError = signal<string | null>(null);
    readonly dragOver = signal(false);

    private readonly area = viewChild<ElementRef<HTMLTextAreaElement>>('area');
    private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
    private typingActive = false;
    private typingTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        // Only when it actually changes: writing on every render would fight the user's typing.
        effect(() => {
            const text = this.initialText();
            const attachments = this.initialAttachments();
            untracked(() => {
                this.text.set(text);
                const element = this.area()?.nativeElement;
                if (element) {
                    element.value = text;
                    element.focus();
                }

                this.revokeStaged(this.staged());
                this.staged.set(attachments.map((file) => ({ file, previewUrl: null })));
            });
        });

        this.destroyRef.onDestroy(() => this.revokeStaged(this.staged()));
    }

    readonly sendIcon = Send;
    readonly paperclipIcon = Paperclip;
    readonly refreshIcon = RefreshCw;
    readonly shieldAlertIcon = ShieldAlert;
    readonly filmIcon = Film;
    readonly closeIcon = X;

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

    onFilePicked(event: Event): void {
        const input = event.target as HTMLInputElement;
        void this.stageFiles(input.files);
        input.value = '';
    }

    onDragOver(event: DragEvent): void {
        event.preventDefault();
        this.dragOver.set(true);
    }

    onDragLeave(event: DragEvent): void {
        event.preventDefault();
        this.dragOver.set(false);
    }

    onDrop(event: DragEvent): void {
        event.preventDefault();
        this.dragOver.set(false);
        void this.stageFiles(event.dataTransfer?.files ?? null);
    }

    onPaste(event: ClipboardEvent): void {
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
            void this.stageFiles(files);
        }
    }

    /**
     * Encrypt and upload every file, staging it as soon as its own upload resolves.
     *
     * Uploaded ahead of the send because the message references the object by URL. Note the server
     * reaps unreferenced blobs after 24 hours, so a file staged and never sent does not linger.
     */
    async stageFiles(files: FileList | File[] | null): Promise<void> {
        if (!files || files.length === 0) {
            return;
        }

        this.uploading.set(true);
        this.uploadError.set(null);

        try {
            for (const file of Array.from(files)) {
                await this.stageOne(file);
            }
        } catch {
            this.uploadError.set('Could not upload that file.');
        } finally {
            this.uploading.set(false);
        }
    }

    private async stageOne(file: File): Promise<void> {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { blob, key } = await encryptAttachment(bytes);

        const kind = inferKind(file.type);
        // The preview is built from the original, unencrypted bytes — never the encrypted blob,
        // which would just render as noise.
        const previewUrl = kind === 'image' || kind === 'gif' || kind === 'video' ? URL.createObjectURL(file) : null;

        const uploaded = await firstValueFrom(
            this.profileApi.upload(new Blob([blob as BufferSource]), 'message', file.name)
        );

        const staged: StagedAttachment = {
            file: {
                ...uploaded,
                kind,
                decryptionKey: key,
            },
            previewUrl,
        };

        this.staged.update((list) => [...list, staged]);
    }

    removeAttachment(url: string): void {
        this.staged.update((list) => {
            const match = list.find((entry) => entry.file.url === url);
            if (match) {
                this.revokeStaged([match]);
            }
            return list.filter((entry) => entry.file.url !== url);
        });
    }

    send(): void {
        const value = this.text().trim();
        const attachments = this.staged().map((entry) => entry.file);
        if ((!value && attachments.length === 0) || !this.canSend()) {
            return;
        }

        this.submitted.emit({ text: value, attachments });
        this.text.set('');
        this.revokeStaged(this.staged());
        this.staged.set([]);
        this.stopTyping();

        const element = this.area()?.nativeElement;
        if (element) {
            element.value = '';
            element.style.height = 'auto';
        }
    }

    readableSize(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return `${Math.round(bytes / 1024)} KB`;
        }
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    openFilePicker(): void {
        this.fileInput()?.nativeElement.click();
    }

    private revokeStaged(entries: StagedAttachment[]): void {
        for (const entry of entries) {
            if (entry.previewUrl) {
                URL.revokeObjectURL(entry.previewUrl);
            }
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
