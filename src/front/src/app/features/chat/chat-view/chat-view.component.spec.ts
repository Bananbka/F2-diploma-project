import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { DecryptedMessage } from '../../../core/services/message.service';
import { SessionService } from '../../../core/services/session.service';
import { VoiceRecorderService } from '../../../core/services/voice-recorder.service';
import { ChatViewComponent } from './chat-view.component';

function decryptedMessage(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'm1',
        chatId: 'c1',
        senderId: 'u1',
        createdAt: new Date().toISOString(),
        text: 'hi',
        status: 'ok',
        isEdited: false,
        replyToId: null,
        forwardedFrom: null,
        attachments: [],
        senderVerified: true,
        reactions: [],
        isPinned: false,
        ...overrides,
    };
}

/**
 * `ChatViewComponent` reads a wide surface of `ChatStoreService` signals during construction (its
 * class-field initializers), so the fake only needs to cover those — nothing here calls
 * `fixture.detectChanges()`, so the template and its child components (which pull in their own,
 * much larger dependency graphs) are never rendered.
 */
function fakeChatStore(): Partial<ChatStoreService> {
    return {
        activeChat: signal(null),
        conversation: signal([]),
        messagesLoading: signal(false),
        hasMoreHistory: signal(false),
        isRekeying: signal(false),
        canSend: signal(true),
        memberVerificationError: signal(null),
        encryptionUnavailable: signal(false),
        sendBlockedReason: signal(null),
        pinnedMessages: signal([]),
        canPinMessages: signal(false),
        isSelecting: signal(false),
        selectedIds: signal(new Set<string>()),
        selectionCount: signal(0),
        forwardableCount: signal(0),
        deletableCount: signal(0),
        chats: signal([]),
        typingUserIds: signal([]),
        onlineUserIds: signal([]),
        activeChatId: signal(null),
        realtimeError: signal(null),
    } as unknown as Partial<ChatStoreService>;
}

describe('ChatViewComponent', () => {
    let component: ChatViewComponent;
    let voiceRecorder: {
        recordingState: ReturnType<typeof signal<'idle' | 'recording' | 'stopped'>>;
        cancel: jasmine.Spy;
    };

    beforeEach(() => {
        voiceRecorder = {
            recordingState: signal<'idle' | 'recording' | 'stopped'>('idle'),
            cancel: jasmine.createSpy('cancel'),
        };

        TestBed.configureTestingModule({
            imports: [ChatViewComponent],
            providers: [
                { provide: ChatStoreService, useValue: fakeChatStore() },
                { provide: DirectoryService, useValue: jasmine.createSpyObj('DirectoryService', ['isMe', 'lookup']) },
                { provide: SessionService, useValue: { user: signal(null) } },
                { provide: Router, useValue: jasmine.createSpyObj('Router', ['navigate']) },
                { provide: VoiceRecorderService, useValue: voiceRecorder },
            ],
        });

        component = TestBed.createComponent(ChatViewComponent).componentInstance;
    });

    /**
     * The mic button is disabled while `editing()` is already true, but the reverse ordering —
     * start recording, then start editing a *different* message while it's still in flight — was
     * unguarded: `startEdit()` had no idea a recording existed, so a confirmed recording later
     * routed into `editMessage` against whatever message editing had switched to, silently
     * replacing its text and attachments with the unrelated voice note.
     */
    it('cancels an in-progress recording before entering edit mode', () => {
        voiceRecorder.recordingState.set('recording');
        const message = decryptedMessage({ id: 'm2' });

        component.startEdit(message);

        expect(voiceRecorder.cancel).toHaveBeenCalled();
        expect(component.editing()).toBe(message);
    });

    it('does not touch the recorder when nothing is recording', () => {
        voiceRecorder.recordingState.set('idle');
        const message = decryptedMessage({ id: 'm3' });

        component.startEdit(message);

        expect(voiceRecorder.cancel).not.toHaveBeenCalled();
        expect(component.editing()).toBe(message);
    });
});
