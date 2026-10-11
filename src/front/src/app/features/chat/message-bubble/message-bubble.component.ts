import { HttpClient } from '@angular/common/http';
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
} from '@angular/core';
import {
    AlertTriangle,
    Archive,
    Check,
    CheckCheck,
    Clock,
    Film,
    Forward,
    Lock,
    LucideAngularModule,
    LucideIconData,
    MoreVertical,
    Paperclip,
    Pause,
    Pencil,
    Pin,
    Play,
    RefreshCw,
    Reply,
    ShieldAlert,
    ShieldCheck,
    ShieldOff,
    Smile,
    SmilePlus,
    Trash2,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';

import { decryptAttachment } from '../../../core/crypto/attachment-crypto';
import { MessageAttachment } from '../../../core/models/crypto.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { MessageReadReceipt } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { DecryptedMessage, DecryptStatus } from '../../../core/services/message.service';
import { VisibleOnceDirective } from '../../../shared/directives/visible-once.directive';
import { AvatarComponent } from '../../../shared/ui/avatar/avatar.component';
import { messageTime } from '../../../shared/utils/display';

/** Where a media attachment is in its own, separate (lazier) decrypt lifecycle. */
type MediaStatus = 'idle' | 'decrypting' | 'ready' | 'error';

interface MediaEntry {
    status: MediaStatus;
    /** `URL.createObjectURL` on the decrypted plaintext — revoked on removal/destroy. */
    objectUrl?: string;
}

/**
 * The curated quick-react set. Not exhaustive — a full emoji keyboard is out of scope — but this
 * covers the common messenger reactions (Telegram/Discord/Slack all ship a similar short list),
 * plus a text input for anything else. The server accepts any non-ASCII emoji
 * (`validate_emoji`), so "other" is not artificially restricted to this set.
 */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** One emoji, grouped, for rendering as a pill. */
export interface ReactionGroup {
    emoji: string;
    count: number;
    mine: boolean;
}

/**
 * How a status renders.
 *
 * Every `DecryptStatus` gets its own treatment, because collapsing them makes the interface lie
 * about the guarantee — see `docs/ui-states.md`. In particular:
 *
 *   `no_key`      is transient and normal, so it must not look like an error.
 *   `unverified`  decrypted but unauthenticated: the content may be forged, so it must not look
 *                 like ordinary text.
 *   `failed`      could be tampering, so it must not look like a blank message.
 *   `legacy`      is permanently unreadable, so it must not look like loading.
 *   `plaintext`   carries no confidentiality, so it must not show a lock.
 */
interface StatusView {
    /** Body text when the message itself has none. */
    placeholder: string | null;
    detail: string | null;
    tone: 'normal' | 'pending' | 'warn' | 'danger' | 'inert';
    icon: LucideIconData | null;
}

/**
 * How long a `no_key` message stays quiet before it explains itself.
 *
 * `docs/ui-states.md` calls this state transient and normal, and the client now pulls grants on a
 * backoff starting at 400ms, so the overwhelmingly common case resolves within a beat. Announcing a
 * missing key for that beat trains the reader to ignore the notice — and it is the notice that
 * matters on the rare occasion the key really is absent.
 *
 * The message body is still withheld during the grace period. This delays an explanation, never
 * content: nothing unread is ever shown as though it had been decrypted.
 */
const NO_KEY_GRACE_MS = 1500;

/** The quiet first phase of `no_key`: waiting, with no claim that anything is wrong. */
const SETTLING_VIEW: StatusView = {
    placeholder: 'Decrypting…',
    detail: null,
    tone: 'pending',
    icon: null,
};

const STATUS_VIEWS: Record<DecryptStatus, StatusView> = {
    ok: { placeholder: null, detail: null, tone: 'normal', icon: null },
    plaintext: { placeholder: null, detail: null, tone: 'normal', icon: null },
    no_key: {
        placeholder: 'Waiting for this sender’s key',
        detail: 'They have not wrapped their chain for your device yet. This usually resolves on its own.',
        tone: 'pending',
        icon: Lock,
    },
    unverified: {
        placeholder: null,
        detail: 'Signature did not verify — this content may have been forged.',
        tone: 'warn',
        icon: ShieldAlert,
    },
    failed: {
        placeholder: 'Could not be decrypted',
        detail: 'Tampering, a consumed chain index, or a stale grant. The original content is not recoverable here.',
        tone: 'danger',
        icon: AlertTriangle,
    },
    legacy: {
        placeholder: 'Permanently unreadable',
        detail: 'Encrypted with the pre-migration scheme. There is no key that can open it.',
        tone: 'inert',
        icon: Archive,
    },
};

@Component({
    selector: 'app-message-bubble',
    imports: [LucideAngularModule, AvatarComponent, VisibleOnceDirective],
    templateUrl: './message-bubble.component.html',
    styleUrl: './message-bubble.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        '(contextmenu)': 'onContextMenu($event)',
        '(dblclick)': 'onDoubleClick($event)',
        '(click)': 'onClick()',
        '[class.is-selectable]': 'selecting()',
        '[class.is-selected]': 'selected()',
        // Addressable so a reply quote can scroll to the message it quotes.
        '[attr.id]': '"msg-" + message().id',
        '[class.is-outgoing]': 'isOwn()',
        '[attr.data-delivery]': 'delivery()',
        // An attribute rather than a `[class]` string: a class-map binding competes with the
        // `[class.is-outgoing]` binding for the same property, and the tone styles need both to be
        // reliably present at once.
        '[attr.data-tone]': 'view().tone',
    },
})
export class MessageBubbleComponent {
    private readonly directory = inject(DirectoryService);
    private readonly chatApi = inject(ChatApiService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly http = inject(HttpClient);
    private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

    readonly message = input.required<DecryptedMessage>();
    /** Groups and channels label each sender; a two-party chat does not need to. */
    readonly showSender = input(true);
    readonly canDelete = input(false);
    /**
     * Where an outgoing message is in its journey.
     *
     * Present so a message still being sent renders through this component rather than a parallel
     * one. Two implementations of a bubble cannot be kept pixel-identical by hand, and any drift
     * shows up as the message restyling itself the instant the send is accepted.
     */
    readonly delivery = input<'sent' | 'sending' | 'failed'>('sent');

    /**
     * How many of the chat's other participants have read up to this message — `null` when there
     * is nothing to report (a channel, or a message not yet accepted by the server).
     *
     * Rendered only for the current user's own sent messages: a bubble for someone else's message
     * has nothing useful to say about who has read it.
     */
    readonly readReceipt = input<MessageReadReceipt | null>(null);

    readonly deleteRequested = output<string>();
    readonly editRequested = output<DecryptedMessage>();
    readonly replyRequested = output<DecryptedMessage>();
    /** Right-click, the Menu key, or the overflow button — all ask for the same menu. */
    readonly menuRequested = output<{ message: DecryptedMessage; x: number; y: number }>();
    /** Tapping a quote asks to be taken to the message it quotes. */
    readonly jumpRequested = output<string>();
    readonly selectionToggled = output<string>();
    /**
     * Emitted for both adding and removing: the store's `react` call is itself a toggle, so a pill
     * we already hold and a fresh pick from the tray both go through the same event.
     */
    readonly reactionToggled = output<string>();

    /** True while a bulk selection is in progress anywhere in the conversation. */
    readonly selecting = input(false);
    readonly selected = input(false);

    /** The message this one answers, if it is on screen. */
    readonly replyTo = input<DecryptedMessage | null>(null);

    /**
     * Only our own readable messages can be edited.
     *
     * An edit re-seals the content under a fresh chain index, which means composing new ciphertext —
     * impossible for a message we could not open, and meaningless for a channel post or a legacy one.
     */
    readonly canEdit = computed(() => this.isOwn() && this.message().status === 'ok');

    /** True while a freshly seen `no_key` is still within its grace period. */
    private readonly settling = signal(false);

    readonly isOwn = computed(() => this.directory.isMe(this.message().senderId));
    readonly sender = computed(() => this.directory.lookup(this.message().senderId));
    readonly time = computed(() => messageTime(this.message().createdAt));

    readonly view = computed(() => {
        const status = this.message().status;
        return status === 'no_key' && this.settling() ? SETTLING_VIEW : STATUS_VIEWS[status];
    });

    /** Only ever true when a signature was actually checked and passed — never a default. */
    readonly showVerified = computed(() => this.message().senderVerified && this.message().status === 'ok');

    /** A channel post is signed but not confidential, so it gets the opposite of a lock. */
    readonly showBroadcastMark = computed(() => this.message().status === 'plaintext');

    /**
     * Only decrypt and render real media for a message we actually opened. `docs/ui-states.md`
     * governs every other status — `no_key`/`unverified`/`failed`/`legacy` must never show
     * anything that looks like successfully-rendered content, attachments included.
     */
    readonly canRenderMedia = computed(() => {
        const status = this.message().status;
        return status === 'ok' || status === 'plaintext';
    });

    /** A sticker is a bare image with no bubble chrome — only when it is the *entire* message. */
    readonly isStickerOnly = computed(() => {
        const message = this.message();
        return (
            this.canRenderMedia() &&
            !message.text &&
            message.attachments.length === 1 &&
            message.attachments[0].kind === 'sticker'
        );
    });

    /** Per-attachment decrypt state, keyed by url. A `Map` so one re-render covers every tile. */
    readonly mediaState = signal<Map<string, MediaEntry>>(new Map());
    /** The one audio attachment currently playing, if any — native elements are looked up by url. */
    readonly playingUrl = signal<string | null>(null);

    readonly playIcon = Play;
    readonly pauseIcon = Pause;
    readonly filmIcon = Film;
    readonly alertIcon = AlertTriangle;

    constructor() {
        let timer: ReturnType<typeof setTimeout> | null = null;

        // Audio decrypts immediately on render — voice notes are small — unlike image/video, which
        // wait for `appVisibleOnce` so a long scrollback does not decrypt every video in it at once.
        effect(() => {
            const message = this.message();
            const canRender = this.canRenderMedia();

            untracked(() => {
                if (!canRender) {
                    return;
                }
                for (const file of message.attachments) {
                    if (file.kind === 'audio') {
                        void this.ensureDecrypted(file);
                    }
                }
            });
        });

        this.destroyRef.onDestroy(() => this.revokeMediaUrls());

        // Only the first sighting of a no_key gets the grace period. A message still unreadable after
        // the retries have run stays escalated rather than flickering back to a calm state.
        effect(() => {
            const isMissingKey = this.message().status === 'no_key';

            untracked(() => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }

                this.settling.set(isMissingKey);
                if (isMissingKey) {
                    timer = setTimeout(() => this.settling.set(false), NO_KEY_GRACE_MS);
                }
            });
        });

        this.destroyRef.onDestroy(() => {
            if (timer) {
                clearTimeout(timer);
            }
        });

        // Close the reaction tray on any click outside it, the same pattern the context menu uses.
        const onPointerDown = (event: MouseEvent) => {
            if (!this.pickerOpen()) {
                return;
            }
            const target = event.target as HTMLElement;
            if (!target.closest('.reactions-picker') && !target.closest('.react-trigger')) {
                this.closePicker();
            }
        };
        document.addEventListener('mousedown', onPointerDown, true);
        this.destroyRef.onDestroy(() => document.removeEventListener('mousedown', onPointerDown, true));
    }

    /**
     * Every other participant has read up to this message.
     *
     * A private chat has exactly one "other", so this is the ordinary read/unread tick. A group's
     * `total` is every other member, so this is only true once the whole roster has caught up —
     * `showReadCount` covers the more common partial case.
     */
    readonly isFullyRead = computed(() => {
        const receipt = this.readReceipt();
        return (
            this.delivery() === 'sent' && receipt !== null && receipt.total > 0 && receipt.readCount >= receipt.total
        );
    });

    /** A group chat, not yet fully read: worth a compact "N/M" next to the tick. */
    readonly showReadCount = computed(() => {
        const receipt = this.readReceipt();
        return this.delivery() === 'sent' && receipt !== null && receipt.total > 1 && receipt.readCount < receipt.total;
    });

    readonly deliveryTitle = computed(() => {
        if (this.delivery() === 'sending') {
            return 'Sending';
        }
        if (this.delivery() === 'failed') {
            return 'Not sent';
        }
        if (this.isFullyRead()) {
            return 'Read';
        }
        const receipt = this.readReceipt();
        if (receipt && receipt.readCount > 0) {
            return `Read by ${receipt.readCount} of ${receipt.total}`;
        }
        return 'Sent';
    });

    /** The status glyph for our own message: pending, delivered, or rejected. */
    readonly deliveryIcon = computed(() => {
        switch (this.delivery()) {
            case 'sending':
                return Clock;
            case 'failed':
                return AlertTriangle;
            default:
                return this.isFullyRead() ? this.checkCheckIcon : this.checkIcon;
        }
    });

    readonly checkIcon = Check;
    readonly checkCheckIcon = CheckCheck;
    readonly refreshIcon = RefreshCw;
    readonly shieldCheckIcon = ShieldCheck;
    readonly shieldOffIcon = ShieldOff;
    readonly trashIcon = Trash2;
    readonly replyIcon = Reply;
    readonly editIcon = Pencil;
    readonly paperclipIcon = Paperclip;
    readonly moreIcon = MoreVertical;
    readonly forwardIcon = Forward;
    readonly smileIcon = Smile;
    readonly smilePlusIcon = SmilePlus;
    readonly pinIcon = Pin;

    readonly quickReactions = QUICK_REACTIONS;

    /** Open while picking a reaction from the tray. */
    readonly pickerOpen = signal(false);
    readonly customEmoji = signal('');

    /** Reactions on this message, grouped by emoji so the bubble renders one pill per emoji. */
    readonly reactionGroups = computed<ReactionGroup[]>(() => {
        const reactions = this.message().reactions;
        const groups = new Map<string, ReactionGroup>();

        for (const reaction of reactions) {
            const existing = groups.get(reaction.emoji);
            const mine = existing?.mine || this.directory.isMe(reaction.user_id);
            groups.set(reaction.emoji, {
                emoji: reaction.emoji,
                count: (existing?.count ?? 0) + 1,
                mine,
            });
        }

        return [...groups.values()];
    });

    /** The original author of a forwarded copy, resolved like any other sender. */
    readonly forwardedAuthor = computed(() => {
        const origin = this.message().forwardedFrom;
        if (!origin) {
            return '';
        }
        return this.directory.isMe(origin.user_id) ? 'you' : this.directory.lookup(origin.user_id).name;
    });

    /**
     * Open the actions menu at the pointer.
     *
     * The browser menu is suppressed on purpose — these actions are the useful ones here, and the
     * content is ciphertext the browser's own items cannot do anything sensible with. The Menu key
     * and Shift+F10 raise this same event, so the keyboard path comes free.
     */
    onContextMenu(event: MouseEvent): void {
        event.preventDefault();
        this.menuRequested.emit({ message: this.message(), x: event.clientX, y: event.clientY });
    }

    /**
     * Double-click replies, the way Telegram does.
     *
     * The default action is suppressed because a double-click would otherwise select a word, leaving
     * a stray highlight behind every reply. Suppressed only when it actually starts a reply, so
     * double-clicking to select a word still works while picking messages for a bulk action.
     */
    onDoubleClick(event: MouseEvent): void {
        if (this.selecting()) {
            return;
        }

        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        this.replyRequested.emit(this.message());
    }

    /** While a selection is in progress a plain click picks messages rather than doing nothing. */
    onClick(): void {
        if (this.selecting()) {
            this.selectionToggled.emit(this.message().id);
        }
    }

    /** Touch and trackpad users who have no right button still need a way in. */
    openMenuFromButton(event: MouseEvent): void {
        event.stopPropagation();
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        this.menuRequested.emit({ message: this.message(), x: rect.left, y: rect.bottom + 4 });
    }

    downloadUrl(file: MessageAttachment): string {
        return this.chatApi.attachmentUrl(this.message().chatId, file.url);
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

    mediaStatus(url: string): MediaStatus {
        return this.mediaState().get(url)?.status ?? 'idle';
    }

    mediaObjectUrl(url: string): string | undefined {
        return this.mediaState().get(url)?.objectUrl;
    }

    /** Bound to `appVisibleOnce` on an image/video tile — starts its decrypt the first time it is scrolled into view. */
    onMediaVisible(file: MessageAttachment): void {
        void this.ensureDecrypted(file);
    }

    formatDuration(ms: number | null | undefined): string {
        const totalSeconds = Math.max(0, Math.round((ms ?? 0) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    /** A flat waveform when the attachment carries none — still looks like a waveform, not nothing. */
    waveform(file: MessageAttachment): number[] {
        return file.waveform && file.waveform.length > 0 ? file.waveform : new Array(24).fill(0.3);
    }

    barHeight(amplitude: number): number {
        return Math.max(12, Math.min(100, Math.round(amplitude * 100)));
    }

    toggleAudio(file: MessageAttachment): void {
        const audio = this.elementRef.nativeElement.querySelector<HTMLAudioElement>(
            `audio[data-audio-url="${CSS.escape(file.url)}"]`
        );
        if (!audio) {
            return;
        }

        if (this.playingUrl() === file.url) {
            audio.pause();
            this.playingUrl.set(null);
            return;
        }

        void audio.play();
        this.playingUrl.set(file.url);
    }

    onAudioEnded(file: MessageAttachment): void {
        if (this.playingUrl() === file.url) {
            this.playingUrl.set(null);
        }
    }

    /**
     * Fetch, decrypt and stage one attachment's plaintext as a blob url.
     *
     * Idempotent per url: a tile that has already started (or finished) decrypting is left alone,
     * so `appVisibleOnce` firing more than once, or the audio effect re-running on an unrelated
     * signal change, never re-issues the request.
     */
    private async ensureDecrypted(file: MessageAttachment): Promise<void> {
        if (this.mediaState().has(file.url)) {
            return;
        }
        this.mediaState.update((current) => new Map(current).set(file.url, { status: 'decrypting' }));

        try {
            if (!file.decryptionKey) {
                throw new Error('no attachment key');
            }

            const ciphertext = await firstValueFrom(
                this.http.get(this.downloadUrl(file), { responseType: 'arraybuffer' })
            );
            const plaintext = await decryptAttachment(new Uint8Array(ciphertext), file.decryptionKey);
            const blob = new Blob([plaintext as BufferSource], { type: file.content_type });
            const objectUrl = URL.createObjectURL(blob);

            this.mediaState.update((current) => new Map(current).set(file.url, { status: 'ready', objectUrl }));
        } catch {
            this.mediaState.update((current) => new Map(current).set(file.url, { status: 'error' }));
        }
    }

    private revokeMediaUrls(): void {
        for (const entry of this.mediaState().values()) {
            if (entry.objectUrl) {
                URL.revokeObjectURL(entry.objectUrl);
            }
        }
    }

    /** Who wrote the quoted message, resolved the same way any other sender is. */
    readonly quotedAuthor = computed(() => {
        const quoted = this.replyTo();
        if (!quoted) {
            return '';
        }
        return this.directory.isMe(quoted.senderId) ? 'You' : this.directory.lookup(quoted.senderId).name;
    });

    togglePicker(event: MouseEvent): void {
        event.stopPropagation();
        this.pickerOpen.update((open) => !open);
        this.customEmoji.set('');
    }

    closePicker(): void {
        this.pickerOpen.set(false);
        this.customEmoji.set('');
    }

    /** Clicking a pill toggles it: pick it again to remove your own, or add it if it is not yours. */
    onPillClick(emoji: string): void {
        this.reactionToggled.emit(emoji);
    }

    pickReaction(emoji: string): void {
        this.reactionToggled.emit(emoji);
        this.closePicker();
    }

    submitCustomEmoji(): void {
        const emoji = this.customEmoji().trim();
        // Mirrors the server's own check (`validate_emoji`): reject plain text so the request is
        // not sent only to be rejected, without trying to fully validate Unicode grapheme clusters.
        if (emoji && !this.isAscii(emoji)) {
            this.reactionToggled.emit(emoji);
        }
        this.closePicker();
    }

    private isAscii(value: string): boolean {
        return /^[\x00-\x7F]*$/.test(value);
    }
}
