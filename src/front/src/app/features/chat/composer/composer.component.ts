import {
    ChangeDetectionStrategy,
    Component,
    computed,
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
import {
    Check,
    Film,
    LucideAngularModule,
    Mic,
    Paperclip,
    RefreshCw,
    Send,
    ShieldAlert,
    Smile,
    Sticker,
    Trash2,
    UserX,
    X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { computeWaveformPeaks } from '../../../core/audio/waveform';
import { encryptAttachment } from '../../../core/crypto/attachment-crypto';
import { AttachmentKind, MessageAttachment } from '../../../core/models/crypto.model';
import { Sticker as StickerModel } from '../../../core/models/sticker.model';
import { ChatPanelStoreService, ComposerBridge } from '../../../core/services/chat-panel-store.service';
import { ProfileApiService } from '../../../core/services/profile-api.service';
import { VoiceRecorderService } from '../../../core/services/voice-recorder.service';
import { EmojiPickerComponent } from '../../../shared/ui/emoji-picker/emoji-picker.component';
import { StickerPickerComponent } from '../stickers/sticker-picker/sticker-picker.component';

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
    imports: [LucideAngularModule, StickerPickerComponent, EmojiPickerComponent],
    templateUrl: './composer.component.html',
    styleUrl: './composer.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerComponent {
    private readonly profileApi = inject(ProfileApiService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly voiceRecorder = inject(VoiceRecorderService);
    private readonly panel = inject(ChatPanelStoreService);

    readonly stickerPickerOpen = signal(false);
    readonly emojiPickerOpen = signal(false);

    /** False while the member set cannot be verified — sending is refused, not merely discouraged. */
    readonly canSend = input(true);
    readonly blockedReason = input<string | null>(null);
    /**
     * The block is a read-only conversation (the other party deleted their account) rather than a
     * security fault. Rendered as a neutral notice, not the red alarm reserved for a member set
     * that failed verification.
     */
    readonly readOnly = input(false);
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

    readonly micError = signal<string | null>(null);
    readonly recordingElapsedMs = signal(0);
    readonly confirmingRecording = signal(false);
    /** True from the tap on the mic through to `voiceRecorder.start()` resolving (or failing) —
     *  mirrors the service's own `starting` flag, but at the button level: the async gap between
     *  the click and `recordingState()` actually flipping to `'recording'` is exactly the window
     *  a real double-tap lands in, and the service-side guard alone only stops a second real
     *  acquisition, not a second `startElapsedTimer()` call from this component. */
    readonly startingRecording = signal(false);
    readonly recordingAmplitude = this.voiceRecorder.currentAmplitude;
    /** True from the tap on the mic through to the upload finishing — kept true past `stop()`
     *  resolving so the recording row does not flash back to the idle composer mid-upload. */
    readonly showRecordingRow = computed(
        () => this.voiceRecorder.recordingState() === 'recording' || this.confirmingRecording()
    );

    /**
     * Why text/stickers cannot be put into the composer right now, or null when they can.
     *
     * The single source for the emoji and sticker triggers here and for the side panel (through
     * the bridge), so the two surfaces cannot drift apart: a guard added once applies to both.
     */
    readonly unavailableReason = computed<string | null>(() => {
        if (!this.canSend()) {
            return this.readOnly()
                ? (this.blockedReason() ?? 'This conversation is read-only.')
                : (this.blockedReason() ?? 'Sending is blocked.');
        }
        if (this.editing()) {
            return 'Finish or cancel editing the message first.';
        }
        if (this.showRecordingRow()) {
            return 'Finish the voice message first.';
        }
        return null;
    });

    private readonly bridge: ComposerBridge = {
        unavailableReason: this.unavailableReason,
        insertEmoji: (emoji) => this.insertEmoji(emoji),
        sendSticker: (sticker) => this.sendSticker(sticker),
    };

    private readonly area = viewChild<ElementRef<HTMLTextAreaElement>>('area');
    private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
    private typingActive = false;
    private typingTimer: ReturnType<typeof setTimeout> | null = null;
    private recordingTimer: ReturnType<typeof setInterval> | null = null;
    private recordingStartedAt = 0;

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

        this.panel.registerComposer(this.bridge);
        this.destroyRef.onDestroy(() => this.panel.unregisterComposer(this.bridge));

        this.destroyRef.onDestroy(() => this.revokeStaged(this.staged()));
        // The recorder is a root-scoped service, so it outlives this component — if the chat is
        // switched away from mid-recording, this instance is destroyed with no `stop()`/`cancel()`
        // ever called, and the mic would otherwise stay captured.
        this.destroyRef.onDestroy(() => {
            this.stopElapsedTimer();
            this.voiceRecorder.forceRelease();
        });

        // The recorder can also be cancelled from outside this component's own buttons — e.g.
        // `ChatViewComponent.startEdit()` cancels an in-progress recording before switching the
        // composer into edit mode. Watch the service's own state rather than relying on every
        // caller to also stop this timer, or it keeps ticking against a recording that no longer
        // exists.
        effect(() => {
            if (this.voiceRecorder.recordingState() !== 'recording') {
                untracked(() => this.stopElapsedTimer());
            }
        });
    }

    readonly sendIcon = Send;
    readonly paperclipIcon = Paperclip;
    readonly refreshIcon = RefreshCw;
    readonly shieldAlertIcon = ShieldAlert;
    readonly userXIcon = UserX;
    readonly filmIcon = Film;
    readonly closeIcon = X;
    readonly stickerIcon = Sticker;
    readonly smileIcon = Smile;
    readonly micIcon = Mic;
    readonly trashIcon = Trash2;
    readonly checkIcon = Check;

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

    toggleStickerPicker(): void {
        this.stickerPickerOpen.update((open) => !open);
    }

    /**
     * A sticker sends immediately on pick, with no staging step — unlike a file attachment, which
     * waits in the composer until Enter/Send. It carries no `decryptionKey`: stickers are public
     * images in the sticker bucket, never sealed, so nothing downstream needs to decrypt them.
     */
    onStickerPicked(sticker: StickerModel): void {
        this.stickerPickerOpen.set(false);
        this.sendSticker(sticker);
    }

    /** Shared by the tray here and the side panel. Returns whether the sticker was actually sent. */
    sendSticker(sticker: StickerModel): boolean {
        // A sticker carries no `decryptionKey` by design, and `editMessage` rejects attachments
        // without one. The trigger button is disabled while editing, but guard here too: nothing
        // should route a sticker into an edit and lose the user's in-progress draft.
        if (this.unavailableReason() !== null) {
            return false;
        }

        this.submitted.emit({
            text: '',
            attachments: [
                {
                    url: sticker.image_url,
                    name: sticker.emoji || 'sticker',
                    size: 0,
                    content_type: 'image/webp',
                    kind: 'sticker',
                },
            ],
        });
        return true;
    }

    toggleEmojiPicker(): void {
        if (this.unavailableReason() !== null) {
            return;
        }
        this.emojiPickerOpen.update((open) => !open);
    }

    /** The popover's pick: insert, keep the popover open for several in a row, and refocus the box. */
    onEmojiPicked(emoji: string): void {
        this.insertEmoji(emoji);
    }

    /**
     * Insert an emoji at the caret, replacing any selection, and put the caret after it.
     *
     * The textarea keeps its `selectionStart`/`selectionEnd` while blurred, so clicking the picker
     * (which takes focus) does not lose the position. The text signal is the source of truth and
     * the element is written to as well, because the `[value]` binding only re-applies when the
     * signal changes and would otherwise leave the caret at the end.
     */
    insertEmoji(emoji: string): boolean {
        if (this.unavailableReason() !== null || !emoji) {
            return false;
        }

        const element = this.area()?.nativeElement;
        const current = this.text();
        const length = current.length;
        const start = Math.min(element?.selectionStart ?? length, length);
        const end = Math.min(Math.max(element?.selectionEnd ?? start, start), length);

        const next = current.slice(0, start) + emoji + current.slice(end);
        const caret = start + emoji.length;
        this.text.set(next);

        if (element) {
            element.value = next;
            element.setSelectionRange(caret, caret);
            element.focus();
        }

        this.autoGrow();
        this.pingTyping();
        return true;
    }

    /** Tapping the mic button — morphs the composer row into the recording UI on success. */
    async startRecording(): Promise<void> {
        if (!this.canSend() || this.editing() || this.startingRecording()) {
            return;
        }

        this.startingRecording.set(true);
        this.micError.set(null);
        try {
            await this.voiceRecorder.start();
            this.startElapsedTimer();
        } catch {
            // Defense in depth: the service itself now cleans up after a failed start, but a
            // caller-side release too means this path stays safe even if that guarantee ever
            // regresses.
            this.voiceRecorder.forceRelease();
            this.micError.set(
                this.voiceRecorder.permission() === 'denied'
                    ? 'Microphone access was denied.'
                    : 'Could not start recording on this device.'
            );
        } finally {
            this.startingRecording.set(false);
        }
    }

    /** Discard the recording in progress and return to the normal composer row. */
    cancelRecording(): void {
        this.voiceRecorder.cancel();
        this.stopElapsedTimer();
    }

    /**
     * The confirm button IS the send action for a voice note — there is no staging step, the same
     * way a sticker sends immediately on pick.
     */
    async confirmRecording(): Promise<void> {
        // Mirrors the guard in `onStickerPicked()`: the mic button is disabled while `editing()` is
        // already true, but the reverse ordering — start recording, then start editing a different
        // message while it's still in flight — is not blocked at the point where editing begins, so
        // this is the last line of defense against silently routing a voice note into an edit.
        if (this.editing()) {
            this.micError.set("Can't send a voice note while editing a message.");
            this.voiceRecorder.cancel();
            this.stopElapsedTimer();
            return;
        }

        this.confirmingRecording.set(true);
        try {
            const { blob, durationMs } = await this.voiceRecorder.stop();
            this.stopElapsedTimer();

            // Waveform runs on the plaintext bytes — there is no decoding ciphertext as audio.
            const arrayBuffer = await blob.arrayBuffer();
            const waveform = await computeWaveformPeaks(arrayBuffer);
            const { blob: encryptedBlob, key } = await encryptAttachment(new Uint8Array(arrayBuffer));

            const uploaded = await firstValueFrom(
                this.profileApi.upload(
                    new Blob([encryptedBlob as BufferSource]),
                    'message',
                    `voice-message.${this.extensionForMime(blob.type)}`
                )
            );

            this.submitted.emit({
                text: '',
                attachments: [
                    {
                        ...uploaded,
                        kind: 'audio',
                        duration_ms: Math.round(durationMs),
                        waveform,
                        decryptionKey: key,
                    },
                ],
            });
        } catch {
            this.micError.set('Could not send the voice message.');
        } finally {
            this.confirmingRecording.set(false);
        }
    }

    formattedRecordingTime(): string {
        const totalSeconds = Math.floor(this.recordingElapsedMs() / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    private extensionForMime(mimeType: string): string {
        if (mimeType.includes('ogg')) {
            return 'ogg';
        }
        if (mimeType.includes('mp4')) {
            return 'mp4';
        }
        return 'webm';
    }

    private startElapsedTimer(): void {
        // Defensive backstop: a function that creates a resource should be safe to call twice.
        // `startingRecording` already prevents a real double-tap from reaching here a second
        // time, but clear any existing interval first regardless, rather than trusting the
        // caller to never call this twice.
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
        }

        this.recordingStartedAt = performance.now();
        this.recordingElapsedMs.set(0);
        this.recordingTimer = setInterval(() => {
            this.recordingElapsedMs.set(performance.now() - this.recordingStartedAt);
        }, 200);
    }

    private stopElapsedTimer(): void {
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
        }
        this.recordingElapsedMs.set(0);
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
