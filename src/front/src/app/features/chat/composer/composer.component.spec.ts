import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { MessageAttachment } from '../../../core/models/crypto.model';
import { ChatPanelStoreService } from '../../../core/services/chat-panel-store.service';
import { ProfileApiService, UploadedFile } from '../../../core/services/profile-api.service';
import {
    MicPermissionState,
    RecordingState,
    VoiceRecorderService,
} from '../../../core/services/voice-recorder.service';
import { ComposedMessage, ComposerComponent } from './composer.component';

/**
 * A hand-rolled fake rather than `jasmine.createSpyObj` for the whole service: the component reads
 * `recordingState`/`currentAmplitude`/`permission` as *signals*, which a spy object cannot produce,
 * while `start`/`stop`/`cancel`/`forceRelease` are plain spied methods.
 */
function fakeVoiceRecorder(): jasmine.SpyObj<VoiceRecorderService> & {
    recordingState: ReturnType<typeof signal<RecordingState>>;
    permission: ReturnType<typeof signal<MicPermissionState>>;
} {
    const fake = jasmine.createSpyObj<VoiceRecorderService>('VoiceRecorderService', [
        'start',
        'stop',
        'cancel',
        'forceRelease',
    ]);
    (fake as unknown as { recordingState: unknown }).recordingState = signal<RecordingState>('idle');
    (fake as unknown as { permission: unknown }).permission = signal<MicPermissionState>('idle');
    (fake as unknown as { currentAmplitude: unknown }).currentAmplitude = signal(0);
    fake.start.and.resolveTo(undefined);
    fake.stop.and.resolveTo({ blob: new Blob(['audio']), durationMs: 1200 });
    return fake as unknown as jasmine.SpyObj<VoiceRecorderService> & {
        recordingState: ReturnType<typeof signal<RecordingState>>;
        permission: ReturnType<typeof signal<MicPermissionState>>;
    };
}

function uploaded(url = 'https://files.test/a.png'): UploadedFile {
    return { url, name: 'a.png', size: 10, content_type: 'image/png' };
}

describe('ComposerComponent', () => {
    let fixture: ComponentFixture<ComposerComponent>;
    let profileApi: jasmine.SpyObj<ProfileApiService>;
    let voiceRecorder: ReturnType<typeof fakeVoiceRecorder>;

    function create(): HTMLElement {
        fixture = TestBed.createComponent(ComposerComponent);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        profileApi = jasmine.createSpyObj<ProfileApiService>('ProfileApiService', ['upload']);
        profileApi.upload.and.returnValue(of(uploaded()));

        voiceRecorder = fakeVoiceRecorder();

        await TestBed.configureTestingModule({
            imports: [ComposerComponent],
            providers: [
                { provide: ProfileApiService, useValue: profileApi },
                { provide: VoiceRecorderService, useValue: voiceRecorder },
            ],
        }).compileComponents();
    });

    describe('read-only conversation (deleted peer)', () => {
        function strip(host: HTMLElement): HTMLElement | null {
            return host.querySelector('.strip');
        }

        it('shows a neutral explanatory notice, not the red alarm', () => {
            const host = create();
            fixture.componentRef.setInput('canSend', false);
            fixture.componentRef.setInput('readOnly', true);
            fixture.componentRef.setInput('blockedReason', 'The other person deleted their account.');
            fixture.detectChanges();

            const notice = strip(host);
            expect(notice?.textContent).toContain('The other person deleted their account.');
            expect(notice?.classList.contains('is-danger')).toBeFalse();
            expect(notice?.getAttribute('role')).toBe('status');
        });

        it('disables the box and the send action', () => {
            const host = create();
            fixture.componentRef.setInput('canSend', false);
            fixture.componentRef.setInput('readOnly', true);
            fixture.detectChanges();

            const area = host.querySelector('textarea') as HTMLTextAreaElement;
            expect(area.disabled).toBeTrue();
            expect(area.placeholder).toBe('Read-only conversation');

            fixture.componentInstance.text.set('hello');
            const spy = jasmine.createSpy('submitted');
            fixture.componentInstance.submitted.subscribe(spy);
            fixture.componentInstance.send();
            expect(spy).not.toHaveBeenCalled();
        });

        it('keeps the red alarm for a block that is not read-only', () => {
            const host = create();
            fixture.componentRef.setInput('canSend', false);
            fixture.componentRef.setInput('blockedReason', 'Blocked: the member set could not be verified.');
            fixture.detectChanges();

            expect(strip(host)?.classList.contains('is-danger')).toBeTrue();
            expect((host.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe('Sending is blocked');
        });
    });

    describe('send()', () => {
        it('does nothing when there is no text and no attachment', () => {
            const host = create();
            const spy = jasmine.createSpy('submitted');
            fixture.componentInstance.submitted.subscribe(spy);

            fixture.componentInstance.send();

            expect(spy).not.toHaveBeenCalled();
            expect(host).toBeTruthy();
        });

        it('does nothing while sending is blocked, even with text staged', () => {
            create();
            fixture.componentRef.setInput('canSend', false);
            fixture.componentInstance.text.set('hello');
            fixture.detectChanges();

            const spy = jasmine.createSpy('submitted');
            fixture.componentInstance.submitted.subscribe(spy);
            fixture.componentInstance.send();

            expect(spy).not.toHaveBeenCalled();
        });

        it('emits the trimmed text and attachments, then clears the composer', () => {
            create();
            fixture.componentInstance.text.set('  hello  ');
            fixture.detectChanges();

            let emitted: ComposedMessage | undefined;
            fixture.componentInstance.submitted.subscribe((value) => (emitted = value));
            fixture.componentInstance.send();

            expect(emitted).toEqual({ text: 'hello', attachments: [] });
            expect(fixture.componentInstance.text()).toBe('');
        });
    });

    /**
     * CLAUDE.md's "Lessons from the media/UI features branch" flags this exact shape of regression:
     * a per-trigger `editing()` guard was added to the file-attach button, then had to be
     * separately re-added to the sticker-tray and mic buttons because nothing enforces it
     * structurally. These pin every trigger's guard down so a future trigger that forgets it fails
     * a test rather than shipping silently.
     */
    describe('editing() guards every composer trigger — see CLAUDE.md "Lessons"', () => {
        it('disables the sticker-tray trigger while editing', () => {
            const host = create();
            fixture.componentRef.setInput('editing', true);
            fixture.detectChanges();

            const trigger = host.querySelector<HTMLButtonElement>('.sticker-trigger');
            expect(trigger?.disabled).toBe(true);
        });

        it('disables the mic trigger while editing', () => {
            const host = create();
            fixture.componentRef.setInput('editing', true);
            fixture.detectChanges();

            const trigger = host.querySelector<HTMLButtonElement>('.mic-trigger');
            expect(trigger?.disabled).toBe(true);
        });

        it('disables the file-attach trigger while sending is blocked (existing guard, kept as a baseline)', () => {
            const host = create();
            fixture.componentRef.setInput('canSend', false);
            fixture.detectChanges();

            const trigger = host.querySelector<HTMLButtonElement>('.side[title="Attach a file"]');
            expect(trigger?.disabled).toBe(true);
        });

        it('onStickerPicked() is a no-op while editing, even if called directly (defense in depth behind the disabled button)', () => {
            create();
            fixture.componentRef.setInput('editing', true);
            fixture.detectChanges();

            const spy = jasmine.createSpy('submitted');
            fixture.componentInstance.submitted.subscribe(spy);

            fixture.componentInstance.onStickerPicked({
                id: 's1',
                pack_id: 'pack',
                image_url: 'https://files.test/s.webp',
                emoji: '😀',
                position: 0,
            });

            expect(spy).not.toHaveBeenCalled();
        });

        it('onStickerPicked() is a no-op while sending is blocked', () => {
            create();
            fixture.componentRef.setInput('canSend', false);
            fixture.detectChanges();

            const spy = jasmine.createSpy('submitted');
            fixture.componentInstance.submitted.subscribe(spy);

            fixture.componentInstance.onStickerPicked({
                id: 's1',
                pack_id: 'pack',
                image_url: 'https://files.test/s.webp',
                emoji: '😀',
                position: 0,
            });

            expect(spy).not.toHaveBeenCalled();
        });

        it('startRecording() refuses to even ask for the mic while editing', async () => {
            create();
            fixture.componentRef.setInput('editing', true);
            fixture.detectChanges();

            await fixture.componentInstance.startRecording();

            expect(voiceRecorder.start).not.toHaveBeenCalled();
        });

        /**
         * The asymmetric case CLAUDE.md calls out by name: editing can start to a *different*
         * message while a voice note is already mid-recording, since the mic button's own
         * `editing()` guard was only checked at the moment recording started. `confirmRecording`
         * must re-check at the point of sending, not just at the point of starting.
         */
        it('confirmRecording() refuses — and discards the recording — if editing started after recording began', async () => {
            create();
            // Recording starts while editing() is still false.
            await fixture.componentInstance.startRecording();
            expect(voiceRecorder.start).toHaveBeenCalledTimes(1);

            // Editing begins mid-recording (mirrors `ChatViewComponent.startEdit` switching the
            // composer into edit mode without having cancelled this recording itself).
            fixture.componentRef.setInput('editing', true);
            fixture.detectChanges();

            const spy = jasmine.createSpy('submitted');
            fixture.componentInstance.submitted.subscribe(spy);

            await fixture.componentInstance.confirmRecording();

            expect(spy).not.toHaveBeenCalled();
            expect(voiceRecorder.cancel).toHaveBeenCalled();
            expect(voiceRecorder.stop).not.toHaveBeenCalled();
            expect(fixture.componentInstance.micError()).toContain("Can't send a voice note while editing");
        });
    });

    describe('voice recording start double-tap guard', () => {
        it('ignores a second tap while the first start() is still in flight', async () => {
            create();
            let resolveStart!: () => void;
            voiceRecorder.start.and.returnValue(new Promise<void>((resolve) => (resolveStart = resolve)));

            const first = fixture.componentInstance.startRecording();
            const second = fixture.componentInstance.startRecording();

            resolveStart();
            await Promise.all([first, second]);

            expect(voiceRecorder.start).toHaveBeenCalledTimes(1);
        });
    });

    describe('staged attachment lifecycle', () => {
        it('stages an uploaded file with an inferred kind and a preview url for an image', async () => {
            const host = create();
            const file = new File(['bytes'], 'photo.png', { type: 'image/png' });

            await fixture.componentInstance.stageFiles([file]);
            fixture.detectChanges();

            const staged = fixture.componentInstance.staged();
            expect(staged.length).toBe(1);
            expect(staged[0].file.kind).toBe('image');
            expect(staged[0].file.decryptionKey).toBeDefined();
            expect(staged[0].previewUrl).toMatch(/^blob:/);
            expect(host.querySelector('.staged-tile')).not.toBeNull();
        });

        it('does not build a preview url for a plain file attachment', async () => {
            create();
            const file = new File(['bytes'], 'doc.pdf', { type: 'application/pdf' });

            await fixture.componentInstance.stageFiles([file]);

            const staged = fixture.componentInstance.staged();
            expect(staged[0].file.kind).toBe('file');
            expect(staged[0].previewUrl).toBeNull();
        });

        it('removeAttachment revokes the preview url and drops the entry', async () => {
            create();
            const file = new File(['bytes'], 'photo.png', { type: 'image/png' });
            await fixture.componentInstance.stageFiles([file]);
            fixture.detectChanges();

            const url = fixture.componentInstance.staged()[0].file.url;
            const revokeSpy = spyOn(URL, 'revokeObjectURL');

            fixture.componentInstance.removeAttachment(url);

            expect(revokeSpy).toHaveBeenCalled();
            expect(fixture.componentInstance.staged().length).toBe(0);
        });

        it('surfaces an upload failure without leaving the uploading flag stuck on', async () => {
            create();
            profileApi.upload.and.throwError('network error');
            const file = new File(['bytes'], 'photo.png', { type: 'image/png' });

            await fixture.componentInstance.stageFiles([file]);

            expect(fixture.componentInstance.uploading()).toBe(false);
            expect(fixture.componentInstance.uploadError()).toBeTruthy();
        });
    });

    describe('emoji insertion', () => {
        const GRIN = '😀';

        function area(host: HTMLElement): HTMLTextAreaElement {
            return host.querySelector('textarea') as HTMLTextAreaElement;
        }

        function typeInto(host: HTMLElement, value: string, caretStart: number, caretEnd = caretStart): void {
            const element = area(host);
            element.focus();
            element.value = value;
            element.dispatchEvent(new Event('input'));
            element.setSelectionRange(caretStart, caretEnd);
            fixture.detectChanges();
        }

        function openPicker(host: HTMLElement): void {
            host.querySelector<HTMLButtonElement>('.emoji-trigger')?.click();
            fixture.detectChanges();
        }

        function clickFirstEmoji(host: HTMLElement): void {
            host.querySelector<HTMLButtonElement>('app-emoji-picker .emoji')?.click();
            fixture.detectChanges();
        }

        it('inserts at the caret from the picker and puts the caret after it, focus back on the box', () => {
            const host = create();
            typeInto(host, 'helloworld', 5);

            openPicker(host);
            // The picker takes focus away from the box; its caret must survive the round trip.
            (document.activeElement as HTMLElement | null)?.blur();
            clickFirstEmoji(host);

            const firstEmoji = host
                .querySelector<HTMLButtonElement>('app-emoji-picker .emoji')
                ?.getAttribute('aria-label');
            expect(fixture.componentInstance.text()).toBe(`hello${firstEmoji}world`);
            expect(area(host).value).toBe(`hello${firstEmoji}world`);
            expect(area(host).selectionStart).toBe(5 + (firstEmoji?.length ?? 0));
            expect(area(host).selectionEnd).toBe(area(host).selectionStart);
            expect(document.activeElement).toBe(area(host));
        });

        it('replaces the selected range', () => {
            create();
            const host = fixture.nativeElement as HTMLElement;
            typeInto(host, 'say XX now', 4, 6);

            expect(fixture.componentInstance.insertEmoji(GRIN)).toBeTrue();

            expect(fixture.componentInstance.text()).toBe(`say ${GRIN} now`);
        });

        it('appends when the box has never been focused', () => {
            const host = create();
            fixture.componentInstance.text.set('abc');
            fixture.detectChanges();

            expect(fixture.componentInstance.insertEmoji(GRIN)).toBeTrue();
            expect(fixture.componentInstance.text()).toBe(`abc${GRIN}`);
            expect(area(host).value).toBe(`abc${GRIN}`);
        });

        it('does not submit anything by itself', () => {
            create();
            const spy = jasmine.createSpy('submitted');
            fixture.componentInstance.submitted.subscribe(spy);

            fixture.componentInstance.insertEmoji(GRIN);

            expect(spy).not.toHaveBeenCalled();
        });

        describe('guards, like every other composer trigger', () => {
            it('disables the emoji trigger while editing and refuses the action itself', () => {
                const host = create();
                fixture.componentRef.setInput('editing', true);
                fixture.detectChanges();

                expect(host.querySelector<HTMLButtonElement>('.emoji-trigger')?.disabled).toBeTrue();

                fixture.componentInstance.toggleEmojiPicker();
                fixture.detectChanges();
                expect(fixture.componentInstance.emojiPickerOpen()).toBeFalse();
                expect(fixture.componentInstance.insertEmoji(GRIN)).toBeFalse();
                expect(fixture.componentInstance.text()).toBe('');
            });

            it('disables the emoji trigger while sending is blocked', () => {
                const host = create();
                fixture.componentRef.setInput('canSend', false);
                fixture.detectChanges();

                expect(host.querySelector<HTMLButtonElement>('.emoji-trigger')?.disabled).toBeTrue();
                expect(fixture.componentInstance.insertEmoji(GRIN)).toBeFalse();
            });

            it('refuses in a read-only conversation', () => {
                const host = create();
                fixture.componentRef.setInput('canSend', false);
                fixture.componentRef.setInput('readOnly', true);
                fixture.detectChanges();

                expect(host.querySelector<HTMLButtonElement>('.emoji-trigger')?.disabled).toBeTrue();
                expect(fixture.componentInstance.insertEmoji(GRIN)).toBeFalse();
                expect(fixture.componentInstance.text()).toBe('');
            });

            it('closes an open picker when editing begins', () => {
                const host = create();
                openPicker(host);
                expect(host.querySelector('app-emoji-picker')).not.toBeNull();

                fixture.componentRef.setInput('editing', true);
                fixture.detectChanges();

                expect(host.querySelector('app-emoji-picker')).toBeNull();
            });

            it('refuses while a voice message is being recorded', () => {
                create();
                voiceRecorder.recordingState.set('recording');
                fixture.detectChanges();

                expect(fixture.componentInstance.insertEmoji(GRIN)).toBeFalse();
            });
        });

        describe('bridge used by the side panel', () => {
            let panel: ChatPanelStoreService;

            beforeEach(() => {
                panel = TestBed.inject(ChatPanelStoreService);
            });

            it('registers on creation and unregisters on destroy', () => {
                create();
                expect(panel.composer()).not.toBeNull();

                fixture.destroy();
                expect(panel.composer()).toBeNull();
            });

            it('inserts through the same path and guards', () => {
                create();
                const bridge = panel.composer()!;

                expect(bridge.unavailableReason()).toBeNull();
                expect(bridge.insertEmoji(GRIN)).toBeTrue();
                expect(fixture.componentInstance.text()).toBe(GRIN);

                fixture.componentRef.setInput('editing', true);
                fixture.detectChanges();
                expect(bridge.unavailableReason()).toBeTruthy();
                expect(bridge.insertEmoji(GRIN)).toBeFalse();
                expect(fixture.componentInstance.text()).toBe(GRIN);
            });

            it('sends a sticker immediately, and refuses while editing or blocked', () => {
                create();
                const bridge = panel.composer()!;
                const sticker = {
                    id: 's1',
                    pack_id: 'pack',
                    image_url: 'https://files.test/s.webp',
                    emoji: GRIN,
                    position: 0,
                };
                const spy = jasmine.createSpy('submitted');
                fixture.componentInstance.submitted.subscribe(spy);

                expect(bridge.sendSticker(sticker)).toBeTrue();
                expect(spy).toHaveBeenCalledTimes(1);
                expect(spy.calls.mostRecent().args[0].attachments[0].kind).toBe('sticker');

                fixture.componentRef.setInput('editing', true);
                fixture.detectChanges();
                expect(bridge.sendSticker(sticker)).toBeFalse();

                fixture.componentRef.setInput('editing', false);
                fixture.componentRef.setInput('canSend', false);
                fixture.detectChanges();
                expect(bridge.sendSticker(sticker)).toBeFalse();
                expect(spy).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('pre-filling an edit', () => {
        it('loads the initial text and attachment list into the composer', () => {
            const existing: MessageAttachment = {
                url: 'https://files.test/existing.png',
                name: 'existing.png',
                size: 5,
                content_type: 'image/png',
                kind: 'image',
            };

            create();
            fixture.componentRef.setInput('initialText', 'already sent text');
            fixture.componentRef.setInput('initialAttachments', [existing]);
            fixture.detectChanges();

            expect(fixture.componentInstance.text()).toBe('already sent text');
            expect(fixture.componentInstance.staged().map((s) => s.file.url)).toEqual([existing.url]);
        });
    });
});
