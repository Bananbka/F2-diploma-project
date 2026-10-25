import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { Chat } from '../../../core/models/chat.model';
import { ChatStoreService, ConversationItem, PendingMessage } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { DecryptedMessage } from '../../../core/services/message.service';
import { SessionService } from '../../../core/services/session.service';
import { RecordingState, VoiceRecorderService } from '../../../core/services/voice-recorder.service';
import { ChatViewComponent } from './chat-view.component';

const CHAT_ID = 'a0000000-0000-4000-8000-000000000001';
const ME = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER = 'cccccccc-0000-4000-8000-000000000003';

const CHAT: Chat = {
    id: CHAT_ID,
    chat_type: 'group',
    title: 'Test group',
    avatar_url: null,
    unread_count: 0,
    last_message: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: null,
    participants: [
        { user_id: ME, role: 'owner', joined_at: '2024-01-01T00:00:00Z' },
        { user_id: OTHER, role: 'member', joined_at: '2024-01-01T00:00:00Z' },
    ],
    muted_until: null,
    is_muted: false,
};

function buildMessage(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'msg-1',
        chatId: CHAT_ID,
        senderId: OTHER,
        createdAt: '2024-01-01T00:00:00Z',
        text: 'hello',
        status: 'ok',
        isEdited: false,
        replyToId: null,
        forwardedFrom: null,
        attachments: [],
        senderVerified: false,
        reactions: [],
        isPinned: false,
        ...overrides,
    };
}

/**
 * A plain fake rather than `jasmine.createSpyObj`: most of `ChatStoreService`'s surface the
 * component reads is signals/computeds (properties, not methods), which a spy object cannot stand
 * in for. Action methods are jasmine spies so calls can be asserted.
 */
function fakeStore() {
    return {
        chats: signal<Chat[]>([CHAT]),
        activeChatId: { set: jasmine.createSpy('activeChatId.set') },
        activeChat: signal<Chat | null>(CHAT),
        conversation: signal<ConversationItem[]>([]),
        messagesLoading: signal(false),
        hasMoreHistory: signal(false),
        // Called from `onScroll()` whenever `hasMoreHistory()` is true and the user has scrolled
        // near the top. No current test flips `hasMoreHistory` and drives a scroll, but omitting
        // this method entirely would leave the fake silently diverged from the real service's
        // shape — a later test exercising that path would hit "loadOlder is not a function"
        // instead of a real assertion failure, and `useValue` isn't type-checked against
        // `ChatStoreService` strictly enough to catch the gap at compile time.
        loadOlder: jasmine.createSpy('loadOlder').and.resolveTo(undefined),
        isRekeying: signal(false),
        canSend: signal(true),
        memberVerificationError: signal<string | null>(null),
        encryptionUnavailable: signal<string | null>(null),
        sendBlockedReason: signal<string | null>(null),
        peerDeleted: signal(false),
        pinnedMessages: signal<DecryptedMessage[]>([]),
        canPinMessages: signal(false),
        isSelecting: signal(false),
        selectedIds: signal(new Set<string>()),
        selectionCount: signal(0),
        forwardableCount: signal(0),
        deletableCount: signal(0),
        typingUserIds: signal<string[]>([]),
        onlineUserIds: signal<string[]>([]),
        realtimeError: signal<string | null>(null),
        toggleSelected: jasmine.createSpy('toggleSelected'),
        clearSelection: jasmine.createSpy('clearSelection'),
        deleteSelected: jasmine.createSpy('deleteSelected').and.resolveTo(undefined),
        forwardSelected: jasmine.createSpy('forwardSelected').and.resolveTo(1),
        readReceipt: jasmine.createSpy('readReceipt').and.returnValue(null),
        send: jasmine.createSpy('send').and.resolveTo(undefined),
        editMessage: jasmine.createSpy('editMessage').and.resolveTo(undefined),
        sendTyping: jasmine.createSpy('sendTyping'),
        retry: jasmine.createSpy('retry').and.resolveTo(undefined),
        discardPending: jasmine.createSpy('discardPending'),
        refreshKeys: jasmine.createSpy('refreshKeys').and.resolveTo(undefined),
        deleteMessage: jasmine.createSpy('deleteMessage').and.resolveTo(undefined),
        react: jasmine.createSpy('react').and.resolveTo(undefined),
        pinMessage: jasmine.createSpy('pinMessage').and.resolveTo(undefined),
        unpinMessage: jasmine.createSpy('unpinMessage').and.resolveTo(undefined),
    };
}

/**
 * `ComposerComponent` is rendered as a real child of `ChatViewComponent`, and it reaches into this
 * service for more than just `cancel()` — `currentAmplitude`/`permission` as field initializers,
 * and `forceRelease()` on its own `DestroyRef.onDestroy`. All of it needs a stand-in, not just the
 * one method this spec's own assertions care about.
 */
function fakeVoiceRecorder(): jasmine.SpyObj<VoiceRecorderService> & {
    recordingState: ReturnType<typeof signal<RecordingState>>;
} {
    const fake = jasmine.createSpyObj<VoiceRecorderService>('VoiceRecorderService', [
        'cancel',
        'start',
        'stop',
        'forceRelease',
    ]);
    (fake as unknown as { recordingState: unknown }).recordingState = signal<RecordingState>('idle');
    (fake as unknown as { permission: unknown }).permission = signal('idle');
    (fake as unknown as { currentAmplitude: unknown }).currentAmplitude = signal(0);
    return fake as unknown as jasmine.SpyObj<VoiceRecorderService> & {
        recordingState: ReturnType<typeof signal<RecordingState>>;
    };
}

describe('ChatViewComponent', () => {
    let fixture: ComponentFixture<ChatViewComponent>;
    let store: ReturnType<typeof fakeStore>;
    let voiceRecorder: ReturnType<typeof fakeVoiceRecorder>;
    let directory: jasmine.SpyObj<DirectoryService>;

    function create(): HTMLElement {
        fixture = TestBed.createComponent(ChatViewComponent);
        fixture.componentRef.setInput('chatId', CHAT_ID);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        store = fakeStore();
        voiceRecorder = fakeVoiceRecorder();

        directory = jasmine.createSpyObj<DirectoryService>('DirectoryService', ['isMe', 'lookup']);
        directory.isMe.and.callFake((id: string) => id === ME);
        directory.lookup.and.returnValue({
            userId: OTHER,
            name: 'Alice',
            username: 'alice',
            avatarUrl: null,
            resolved: true,
        });

        const session = { user: () => ({ id: ME }) } as unknown as SessionService;

        await TestBed.configureTestingModule({
            imports: [ChatViewComponent],
            providers: [
                provideRouter([]),
                provideHttpClient(),
                provideHttpClientTesting(),
                { provide: ChatStoreService, useValue: store },
                { provide: DirectoryService, useValue: directory },
                { provide: SessionService, useValue: session },
                { provide: VoiceRecorderService, useValue: voiceRecorder },
            ],
        }).compileComponents();
    });

    describe('conversation-level states — docs/ui-states.md', () => {
        it('renders the history-floor divider as a permanent notice, not a loading state', () => {
            store.conversation.set([{ kind: 'history-floor' }]);
            const host = create();

            expect(host.textContent).toContain('Messages before you joined are unavailable');
        });

        it('renders the encryption-boundary divider distinctly from the history floor', () => {
            store.conversation.set([{ kind: 'encryption-boundary' }]);
            const host = create();

            expect(host.textContent).toContain('Messages before this point were not encrypted');
            expect(host.querySelector('.divider.is-warn')).not.toBeNull();
        });

        it('blocks sending and shows the roster-verification alarm when the store reports a member-set failure', () => {
            store.memberVerificationError.set('member set hash mismatch');
            store.canSend.set(false);
            store.sendBlockedReason.set('member set hash mismatch');
            const host = create();

            const alarm = host.querySelector('[role="alert"]');
            expect(alarm?.textContent).toContain('Member verification failed');
            const composer = host.querySelector('app-composer');
            expect(composer).not.toBeNull();
        });

        /**
         * A deleted peer is a read-only conversation, not a fault: the history stays on screen,
         * the header names the peer neutrally, and the composer explains rather than alarms.
         */
        it('renders a deleted-peer private chat read-only with a neutral notice, not the alarm', () => {
            const privateChat: Chat = {
                ...CHAT,
                chat_type: 'private',
                title: 'Deleted user',
                peer_is_deleted: true,
                participants: [CHAT.participants[0], CHAT.participants[1]],
            };
            store.activeChat.set(privateChat);
            store.chats.set([privateChat]);
            store.peerDeleted.set(true);
            store.canSend.set(false);
            store.sendBlockedReason.set('The other person deleted their account. This conversation is read-only.');
            const host = create();

            expect(host.querySelector('.identity-name')?.textContent).toContain('Deleted user');
            expect(host.querySelector('.identity-sub')?.textContent).toContain('read-only');
            expect(host.textContent).toContain('The other person deleted their account.');
            expect(host.querySelector('app-composer .strip.is-danger')).toBeNull();
            expect(host.querySelector('.alarm')).toBeNull();
            expect((host.querySelector('app-composer textarea') as HTMLTextAreaElement).disabled).toBeTrue();
        });

        it('shows the re-keying strip while the store reports isRekeying', () => {
            store.isRekeying.set(true);
            const host = create();

            expect(host.textContent).toContain('Chat is re-keying');
        });

        it('marks a channel with a signed-not-encrypted notice rather than claiming confidentiality', () => {
            store.activeChat.set({ ...CHAT, chat_type: 'channel' });
            const host = create();

            expect(host.textContent).toContain('not encrypted');
        });
    });

    describe('openMessageMenu — only offers actions that are actually possible', () => {
        it('offers Edit only for our own message that decrypted ok', () => {
            create();
            fixture.componentInstance.openMessageMenu({
                message: buildMessage({ senderId: ME, status: 'ok' }),
                x: 0,
                y: 0,
            });

            const labels = fixture.componentInstance.menuItems().map((item) => item.label);
            expect(labels).toContain('Edit');
        });

        it('never offers Edit for someone else’s message', () => {
            create();
            fixture.componentInstance.openMessageMenu({
                message: buildMessage({ senderId: OTHER, status: 'ok' }),
                x: 0,
                y: 0,
            });

            const labels = fixture.componentInstance.menuItems().map((item) => item.label);
            expect(labels).not.toContain('Edit');
        });

        it('never offers Edit for our own message we could not decrypt', () => {
            create();
            fixture.componentInstance.openMessageMenu({
                message: buildMessage({ senderId: ME, status: 'failed', text: null }),
                x: 0,
                y: 0,
            });

            const labels = fixture.componentInstance.menuItems().map((item) => item.label);
            expect(labels).not.toContain('Edit');
        });

        it('only offers Copy text when there is readable text', () => {
            create();
            fixture.componentInstance.openMessageMenu({
                message: buildMessage({ status: 'no_key', text: null }),
                x: 0,
                y: 0,
            });

            const labels = fixture.componentInstance.menuItems().map((item) => item.label);
            expect(labels).not.toContain('Copy text');
        });
    });

    describe('startEdit — the recording-cancel-on-edit-start guard', () => {
        it('cancels an in-progress recording before switching into edit mode', () => {
            create();
            voiceRecorder.recordingState.set('recording');

            fixture.componentInstance.startEdit(buildMessage({ senderId: ME, status: 'ok' }));

            expect(voiceRecorder.cancel).toHaveBeenCalled();
            expect(fixture.componentInstance.editing()).not.toBeNull();
        });

        it('does not touch the recorder when nothing is recording', () => {
            create();
            voiceRecorder.recordingState.set('idle');

            fixture.componentInstance.startEdit(buildMessage({ senderId: ME, status: 'ok' }));

            expect(voiceRecorder.cancel).not.toHaveBeenCalled();
        });

        it('clears any in-progress reply when starting an edit, and vice versa', () => {
            create();
            const message = buildMessage({ senderId: ME, status: 'ok' });

            fixture.componentInstance.startReply(message);
            expect(fixture.componentInstance.replyingTo()).not.toBeNull();

            fixture.componentInstance.startEdit(message);
            expect(fixture.componentInstance.replyingTo()).toBeNull();
            expect(fixture.componentInstance.editing()).not.toBeNull();
        });
    });

    describe('canDelete', () => {
        it('delegates to the directory — only our own messages are deletable', () => {
            create();
            expect(fixture.componentInstance.canDelete(ME)).toBe(true);
            expect(fixture.componentInstance.canDelete(OTHER)).toBe(false);
        });
    });

    describe('pendingAsMessage', () => {
        it('represents an unsent message as authored and already "ok", since we wrote it ourselves', () => {
            create();
            const pending: PendingMessage = {
                localId: 'local-1',
                text: 'draft',
                createdAt: '2024-01-01T00:00:00Z',
                status: 'sending',
                rekeyFailure: false,
                clientMessageId: 'cmid-1',
            };

            const asMessage = fixture.componentInstance.pendingAsMessage(pending);

            expect(asMessage.status).toBe('ok');
            expect(asMessage.senderVerified).toBe(true);
            expect(asMessage.senderId).toBe(ME);
            expect(asMessage.text).toBe('draft');
        });
    });

    describe('send()', () => {
        it('routes to editMessage, not send, while editing an existing message', async () => {
            create();
            fixture.componentInstance.editing.set(buildMessage({ id: 'msg-9', senderId: ME, status: 'ok' }));

            await fixture.componentInstance.send({ text: 'updated', attachments: [] });

            expect(store.editMessage).toHaveBeenCalledWith('msg-9', 'updated', []);
            expect(store.send).not.toHaveBeenCalled();
        });

        it('routes to store.send with the reply target when not editing', async () => {
            create();
            const replyTarget = buildMessage({ id: 'msg-5' });
            fixture.componentInstance.startReply(replyTarget);

            await fixture.componentInstance.send({ text: 'hi', attachments: [] });

            expect(store.send).toHaveBeenCalledWith('hi', 'msg-5', []);
        });
    });
});
