import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { MessageAttachment } from '../../../core/models/crypto.model';
import { ProfileApiService, UploadedFile } from '../../../core/services/profile-api.service';
import { VoiceRecorderService } from '../../../core/services/voice-recorder.service';
import { ComposerComponent } from './composer.component';

/**
 * A minimal valid (silent) WAV file, not garbage bytes — `computeWaveformPeaks` runs the real
 * `AudioContext.decodeAudioData` here (consistent with how the rest of this suite exercises real
 * Web APIs rather than mocking them away), and decode failure on undecodable bytes is measurably
 * slower in headless Chromium than a successful decode, which risks tripping Jasmine's default
 * per-spec timeout.
 */
function buildWavBlob(sampleCount = 800): Blob {
    const sampleRate = 8000;
    const bytesPerSample = 2;
    const dataSize = sampleCount * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset: number, value: string): void {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < sampleCount; i++) {
        view.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 20000), true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
    return {
        url: 'files/attachments/chat/existing.png',
        name: 'existing.png',
        size: 10,
        content_type: 'image/png',
        kind: 'image',
        ...overrides,
    };
}

describe('ComposerComponent', () => {
    let fixture: ComponentFixture<ComposerComponent>;
    let component: ComposerComponent;
    let profileApi: jasmine.SpyObj<ProfileApiService>;
    let voiceRecorder: jasmine.SpyObj<VoiceRecorderService> & {
        recordingState: ReturnType<typeof signal<'idle' | 'recording' | 'stopped'>>;
        currentAmplitude: ReturnType<typeof signal<number>>;
        permission: ReturnType<typeof signal<'idle' | 'granted' | 'denied' | 'unavailable'>>;
    };

    beforeEach(() => {
        profileApi = jasmine.createSpyObj('ProfileApiService', ['upload']);

        const recorderSpy = jasmine.createSpyObj('VoiceRecorderService', ['start', 'stop', 'cancel', 'forceRelease']);
        voiceRecorder = Object.assign(recorderSpy, {
            recordingState: signal<'idle' | 'recording' | 'stopped'>('idle'),
            currentAmplitude: signal(0),
            permission: signal<'idle' | 'granted' | 'denied' | 'unavailable'>('idle'),
        });

        TestBed.configureTestingModule({
            imports: [ComposerComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                { provide: ProfileApiService, useValue: profileApi },
                { provide: VoiceRecorderService, useValue: voiceRecorder },
            ],
        });

        fixture = TestBed.createComponent(ComposerComponent);
        component = fixture.componentInstance;
    });

    /**
     * `PUT /messages/{id}` now accepts an `attachments` field, so an edit session must let the
     * user remove an attachment exactly like a fresh send does — this used to be gated off because
     * the server had nowhere to persist the change.
     */
    it('renders a working remove button for a pre-populated attachment while editing', () => {
        fixture.componentRef.setInput('editing', true);
        fixture.componentRef.setInput('initialAttachments', [attachment()]);
        fixture.detectChanges();

        const removeButton = fixture.nativeElement.querySelector('.staged-file button');
        expect(removeButton).not.toBeNull();

        removeButton.click();
        fixture.detectChanges();

        expect(component.staged()).toEqual([]);
    });

    /** The attach-file control must not be disabled just because an edit is in progress. */
    it('leaves the attach-file button enabled while editing', () => {
        fixture.componentRef.setInput('editing', true);
        fixture.detectChanges();

        const attachButton: HTMLButtonElement = fixture.nativeElement.querySelector('button.side');
        expect(attachButton.disabled).toBeFalse();
    });

    /** Submitting an edit must carry the current staged attachment list, additions included. */
    it('emits the staged attachment list alongside the text on submit', () => {
        fixture.componentRef.setInput('editing', true);
        fixture.componentRef.setInput('initialAttachments', [attachment()]);
        fixture.detectChanges();

        let emitted: { text: string; attachments: MessageAttachment[] } | undefined;
        component.submitted.subscribe((value) => (emitted = value));

        component.onInput('edited text');
        component.send();

        expect(emitted?.text).toBe('edited text');
        expect(emitted?.attachments).toEqual([attachment()]);
    });

    /**
     * A sticker sends immediately, with no staging step and no `decryptionKey` — stickers are
     * public images, never sealed under the attachment-encryption scheme.
     */
    it('sends a sticker immediately as a sticker-kind attachment with no decryption key', () => {
        fixture.detectChanges();

        let emitted: { text: string; attachments: MessageAttachment[] } | undefined;
        component.submitted.subscribe((value) => (emitted = value));

        component.onStickerPicked({
            id: 's1',
            pack_id: 'p1',
            image_url: 'https://files.test/s1.png',
            emoji: '😀',
            position: 0,
        });

        expect(emitted).toEqual({
            text: '',
            attachments: [
                { url: 'https://files.test/s1.png', name: '😀', size: 0, content_type: 'image/webp', kind: 'sticker' },
            ],
        });
        expect(component.stickerPickerOpen()).toBeFalse();
    });

    it('does not send a sticker while sending is blocked', () => {
        fixture.componentRef.setInput('canSend', false);
        fixture.detectChanges();

        let emitted = false;
        component.submitted.subscribe(() => (emitted = true));

        component.onStickerPicked({
            id: 's1',
            pack_id: 'p1',
            image_url: 'https://files.test/s1.png',
            emoji: '😀',
            position: 0,
        });

        expect(emitted).toBeFalse();
    });

    /**
     * A sticker has no `decryptionKey`, and `editMessage` rejects attachments without one. The
     * trigger must be disabled while editing so the picker can never emit into an edit and discard
     * the user's in-progress draft.
     */
    it('disables the sticker-trigger button while editing', () => {
        fixture.componentRef.setInput('editing', true);
        fixture.detectChanges();

        const stickerButton: HTMLButtonElement = fixture.nativeElement.querySelector('.sticker-trigger');
        expect(stickerButton.disabled).toBeTrue();
    });

    it('does not send a sticker while editing, even if picked directly', () => {
        fixture.componentRef.setInput('editing', true);
        fixture.detectChanges();

        let emitted = false;
        component.submitted.subscribe(() => (emitted = true));

        component.onStickerPicked({
            id: 's1',
            pack_id: 'p1',
            image_url: 'https://files.test/s1.png',
            emoji: '😀',
            position: 0,
        });

        expect(emitted).toBeFalse();
    });

    /**
     * A recorded voice note has no pre-existing `decryptionKey` to carry forward, and recording
     * while editing is also just a confusing interaction to support in a first pass — same
     * reasoning that disables the sticker-tray trigger.
     */
    it('disables the mic button while editing', () => {
        fixture.componentRef.setInput('editing', true);
        fixture.detectChanges();

        const micButton: HTMLButtonElement = fixture.nativeElement.querySelector('.mic-trigger');
        expect(micButton.disabled).toBeTrue();
    });

    it('clicking the mic button starts a recording', () => {
        voiceRecorder.start.and.resolveTo();
        fixture.detectChanges();

        const micButton: HTMLButtonElement = fixture.nativeElement.querySelector('.mic-trigger');
        micButton.click();

        expect(voiceRecorder.start).toHaveBeenCalled();
    });

    /**
     * The service-level guard (`starting` flag in `VoiceRecorderService`) only stops a second real
     * `getUserMedia`/`MediaRecorder` acquisition — it still resolves the second `start()` call
     * successfully. Without a composer-level guard too, that second resolution used to call
     * `startElapsedTimer()` a second time, silently overwriting `recordingTimer` and leaking the
     * first interval forever. This double-taps the mic button the same way, without awaiting
     * between the two calls, and asserts only one interval is ever created.
     */
    it('double-tapping the mic button before start() resolves only starts one elapsed timer', async () => {
        let resolveStart!: () => void;
        voiceRecorder.start.and.returnValue(new Promise<void>((resolve) => (resolveStart = resolve)));
        fixture.detectChanges();

        const setIntervalSpy = spyOn(window, 'setInterval').and.callThrough();

        // Neither call is awaited individually — this is the double-click/rapid-second-tap shape.
        const first = component.startRecording();
        const second = component.startRecording();

        resolveStart();
        await Promise.all([first, second]);

        expect(voiceRecorder.start).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    /**
     * Confirming a recording is itself the send action — there is no staging step the way a
     * regular file attachment has. This exercises the full pipeline: stop -> waveform -> encrypt
     * -> upload -> emit, the exact shape `message.service.ts`'s `attachmentKeys` logic expects.
     */
    it('confirming a recording stops, computes a waveform, encrypts, uploads, and emits an audio attachment', async () => {
        fixture.detectChanges();

        const uploaded: UploadedFile = {
            url: 'files/attachments/chat/voice-message.webm',
            name: 'voice-message.webm',
            size: 42,
            content_type: 'audio/webm',
        };
        profileApi.upload.and.returnValue(of(uploaded));
        voiceRecorder.stop.and.resolveTo({ blob: buildWavBlob(), durationMs: 3210 });

        let emitted: { text: string; attachments: MessageAttachment[] } | undefined;
        component.submitted.subscribe((value) => (emitted = value));

        await component.confirmRecording();

        expect(voiceRecorder.stop).toHaveBeenCalled();
        expect(profileApi.upload).toHaveBeenCalled();
        expect(emitted?.text).toBe('');
        expect(emitted?.attachments.length).toBe(1);

        const attachment = emitted!.attachments[0];
        expect(attachment.kind).toBe('audio');
        expect(attachment.duration_ms).toBe(3210);
        expect(attachment.waveform).toBeDefined();
        expect(attachment.decryptionKey).toBeInstanceOf(Uint8Array);
        expect(attachment.url).toBe(uploaded.url);
    }, 10000);

    it('cancel discards the recording and does not emit submitted', () => {
        fixture.detectChanges();

        let emitted = false;
        component.submitted.subscribe(() => (emitted = true));

        component.cancelRecording();

        expect(voiceRecorder.cancel).toHaveBeenCalled();
        expect(emitted).toBeFalse();
    });

    /**
     * The mic button is disabled while `editing()` is already true, but the reverse ordering
     * (start recording, then an edit starts on a different message while it's still in flight) is
     * not blocked at the point editing begins — so `confirmRecording()` itself must refuse rather
     * than silently emitting a voice attachment into what `ChatViewComponent.send()` would route
     * to `editMessage`.
     */
    it('confirmRecording is a no-op and surfaces an error if editing somehow became true mid-recording', async () => {
        fixture.componentRef.setInput('editing', true);
        fixture.detectChanges();

        let emitted = false;
        component.submitted.subscribe(() => (emitted = true));

        await component.confirmRecording();

        expect(emitted).toBeFalse();
        expect(voiceRecorder.stop).not.toHaveBeenCalled();
        expect(profileApi.upload).not.toHaveBeenCalled();
        expect(voiceRecorder.cancel).toHaveBeenCalled();
        expect(component.micError()).toContain('editing');
    });
});
