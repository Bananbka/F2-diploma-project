import { ComponentFixture, fakeAsync, TestBed, tick } from '@angular/core/testing';

import { MessageAttachment } from '../../../core/models/crypto.model';
import { AttachmentBatchService } from '../../../core/services/attachment-batch.service';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { DecryptedMessage, DecryptStatus } from '../../../core/services/message.service';
import { MessageBubbleComponent } from './message-bubble.component';

const CHAT_ID = 'a0000000-0000-4000-8000-000000000001';
const SENDER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

/** `docs/ui-states.md`'s grace period before a fresh `no_key` explains itself. */
const NO_KEY_GRACE_MS = 1500;

function buildMessage(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'msg-1',
        chatId: CHAT_ID,
        senderId: SENDER_ID,
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

function buildAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
    return {
        url: 'https://files.test/attachment-1',
        name: 'photo.png',
        size: 1024,
        content_type: 'image/png',
        kind: 'image',
        ...overrides,
    };
}

describe('MessageBubbleComponent', () => {
    let fixture: ComponentFixture<MessageBubbleComponent>;

    function create(message: DecryptedMessage): HTMLElement {
        fixture = TestBed.createComponent(MessageBubbleComponent);
        fixture.componentRef.setInput('message', message);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        const directory = jasmine.createSpyObj<DirectoryService>('DirectoryService', ['isMe', 'lookup']);
        directory.isMe.and.returnValue(false);
        directory.lookup.and.returnValue({
            userId: SENDER_ID,
            name: 'Alice',
            username: 'alice',
            avatarUrl: null,
            resolved: true,
        });

        const chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['attachmentUrl']);
        chatApi.attachmentUrl.and.returnValue('https://api.test/files/attachments/chat/key');

        const attachmentBatch = jasmine.createSpyObj<AttachmentBatchService>('AttachmentBatchService', ['fetch']);
        attachmentBatch.fetch.and.returnValue(new Promise<ArrayBuffer>(() => undefined));

        await TestBed.configureTestingModule({
            imports: [MessageBubbleComponent],
            providers: [
                { provide: DirectoryService, useValue: directory },
                { provide: ChatApiService, useValue: chatApi },
                { provide: AttachmentBatchService, useValue: attachmentBatch },
            ],
        }).compileComponents();
    });

    describe('per-status rendering — docs/ui-states.md "Message-level states"', () => {
        it('ok: renders the plaintext with no status icon or warning detail', () => {
            const host = create(buildMessage({ status: 'ok', text: 'hi there' }));

            expect(host.querySelector('.text')?.textContent).toContain('hi there');
            expect(host.querySelector('.status-icon')).toBeNull();
            expect(host.querySelector('.detail')).toBeNull();
        });

        it('no_key: during the grace period shows a quiet settling state, not the error-shaped explanation', fakeAsync(() => {
            const host = create(buildMessage({ status: 'no_key', text: null }));
            tick();
            fixture.detectChanges();

            expect(host.querySelector('.is-placeholder')?.textContent).toContain('Decrypting…');
            expect(host.textContent).not.toContain('Waiting for this sender');
        }));

        it('no_key: explains itself only once the grace period elapses, and never shows it as an error', fakeAsync(() => {
            const host = create(buildMessage({ status: 'no_key', text: null }));
            tick(NO_KEY_GRACE_MS);
            fixture.detectChanges();

            expect(host.textContent).toContain('Waiting for this sender');
            expect(host.textContent).toContain('usually resolves on its own');
            expect(fixture.componentInstance.view().tone).toBe('pending');
        }));

        it('unverified: flags a signature failure without hiding the content as if it were ordinary text', () => {
            const host = create(buildMessage({ status: 'unverified', text: 'forged?' }));

            expect(host.querySelector('.text')?.textContent).toContain('forged?');
            expect(host.textContent).toContain('did not verify');
            expect(fixture.componentInstance.view().tone).toBe('warn');
        });

        it('failed: shows an explicit placeholder rather than a blank message', () => {
            const host = create(buildMessage({ status: 'failed', text: null }));

            expect(host.querySelector('.is-placeholder')?.textContent).toContain('Could not be decrypted');
            expect(fixture.componentInstance.view().tone).toBe('danger');
        });

        it('plaintext: carries no lock affordance — showBroadcastMark is the signed-not-encrypted mark instead', () => {
            create(buildMessage({ status: 'plaintext', text: 'public post' }));

            expect(fixture.componentInstance.showBroadcastMark()).toBe(true);
            expect(fixture.componentInstance.view().icon).toBeNull();
        });

        it('legacy: reads as permanently unreadable, never as a loading state', () => {
            const host = create(buildMessage({ status: 'legacy', text: null }));

            expect(host.querySelector('.is-placeholder')?.textContent).toContain('Permanently unreadable');
            expect(host.textContent).not.toContain('Decrypting');
            expect(fixture.componentInstance.view().tone).toBe('inert');
        });
    });

    describe('canRenderMedia gating', () => {
        const statuses: DecryptStatus[] = ['no_key', 'unverified', 'failed', 'legacy'];

        for (const status of statuses) {
            it(`${status}: an image attachment never renders as successfully-decrypted media`, () => {
                const host = create(
                    buildMessage({
                        status,
                        text: status === 'unverified' ? 'x' : null,
                        attachments: [buildAttachment()],
                    })
                );

                // The template falls back to the plain-file branch whenever canRenderMedia() is false,
                // so a status that must never look "rendered" never produces a media tile or an <img>.
                expect(host.querySelector('.media-tile')).toBeNull();
                expect(host.querySelector('.media-image')).toBeNull();
                expect(fixture.componentInstance.canRenderMedia()).toBe(false);
            });
        }

        it('ok: an image attachment is offered the real media treatment', () => {
            const host = create(buildMessage({ status: 'ok', attachments: [buildAttachment()] }));

            expect(fixture.componentInstance.canRenderMedia()).toBe(true);
            expect(host.querySelector('.media-tile')).not.toBeNull();
        });

        it('plaintext (channel post): media is also allowed, since it is unsealed by design', () => {
            create(buildMessage({ status: 'plaintext', attachments: [buildAttachment()] }));

            expect(fixture.componentInstance.canRenderMedia()).toBe(true);
        });
    });

    describe('isStickerOnly', () => {
        it('is true only for a bare sticker with no text and exactly one sticker attachment', () => {
            create(
                buildMessage({
                    status: 'ok',
                    text: null,
                    attachments: [buildAttachment({ kind: 'sticker', url: 'https://files.test/sticker.webp' })],
                })
            );

            expect(fixture.componentInstance.isStickerOnly()).toBe(true);
        });

        it('is false when the message also carries text', () => {
            create(
                buildMessage({
                    status: 'ok',
                    text: 'look at this',
                    attachments: [buildAttachment({ kind: 'sticker' })],
                })
            );

            expect(fixture.componentInstance.isStickerOnly()).toBe(false);
        });

        it('is false when the status cannot render media at all, even if the only attachment is a sticker', () => {
            create(
                buildMessage({
                    status: 'failed',
                    text: null,
                    attachments: [buildAttachment({ kind: 'sticker' })],
                })
            );

            expect(fixture.componentInstance.isStickerOnly()).toBe(false);
        });
    });

    describe('senderVerified indicator', () => {
        it('is shown only when a signature was actually checked and passed', () => {
            create(buildMessage({ status: 'ok', senderVerified: true }));
            expect(fixture.componentInstance.showVerified()).toBe(true);
        });

        it('is never shown for a status that did not pass verification, even if senderVerified is somehow true', () => {
            create(buildMessage({ status: 'unverified', senderVerified: true }));
            expect(fixture.componentInstance.showVerified()).toBe(false);
        });

        it('is never shown by default', () => {
            create(buildMessage({ status: 'ok', senderVerified: false }));
            expect(fixture.componentInstance.showVerified()).toBe(false);
        });
    });

    describe('sticker pack opening', () => {
        const STICKER_URL = 'https://files.test/sticker.webp';

        function stickerMessage(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
            return buildMessage({
                text: null,
                attachments: [buildAttachment({ kind: 'sticker', url: STICKER_URL })],
                ...overrides,
            });
        }

        function stickerImage(host: HTMLElement): HTMLImageElement {
            return host.querySelector<HTMLImageElement>('.sticker-image')!;
        }

        it('click on the sticker requests its pack by url', () => {
            const host = create(stickerMessage());
            const requested: string[] = [];
            fixture.componentInstance.stickerPackRequested.subscribe((url) => requested.push(url));

            stickerImage(host).click();

            expect(requested).toEqual([STICKER_URL]);
        });

        it('is keyboard reachable: focusable, labelled, and activated by Enter and Space', () => {
            const host = create(stickerMessage());
            const requested: string[] = [];
            fixture.componentInstance.stickerPackRequested.subscribe((url) => requested.push(url));
            const img = stickerImage(host);

            expect(img.getAttribute('tabindex')).toBe('0');
            expect(img.getAttribute('role')).toBe('button');
            expect(img.getAttribute('aria-label')).toBeTruthy();

            const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
            img.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            img.dispatchEvent(space);

            expect(requested).toEqual([STICKER_URL, STICKER_URL]);
            expect(space.defaultPrevented).toBeTrue();
        });

        it('is inert for a message still sending or failed', () => {
            for (const delivery of ['sending', 'failed'] as const) {
                fixture = TestBed.createComponent(MessageBubbleComponent);
                fixture.componentRef.setInput('message', stickerMessage());
                fixture.componentRef.setInput('delivery', delivery);
                fixture.detectChanges();
                const host = fixture.nativeElement as HTMLElement;
                const requested: string[] = [];
                fixture.componentInstance.stickerPackRequested.subscribe((url) => requested.push(url));

                stickerImage(host).click();

                expect(stickerImage(host).getAttribute('tabindex')).toBeNull();
                expect(requested).toEqual([]);
            }
        });

        it('is inert while a bulk selection is in progress', () => {
            fixture = TestBed.createComponent(MessageBubbleComponent);
            fixture.componentRef.setInput('message', stickerMessage());
            fixture.componentRef.setInput('selecting', true);
            fixture.detectChanges();

            expect(stickerImage(fixture.nativeElement as HTMLElement).getAttribute('tabindex')).toBeNull();
        });

        it('does not render a sticker image at all for an unreadable message', () => {
            const host = create(stickerMessage({ status: 'failed' }));

            expect(host.querySelector('.sticker-image')).toBeNull();
        });
    });

    describe('reaction picker outside-click dismiss', () => {
        it('closes when a click lands outside the picker and its trigger', () => {
            const host = create(buildMessage());
            const trigger = host.querySelector<HTMLButtonElement>('.react-trigger')!;
            trigger.click();
            fixture.detectChanges();
            expect(fixture.componentInstance.pickerOpen()).toBe(true);

            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            fixture.detectChanges();

            expect(fixture.componentInstance.pickerOpen()).toBe(false);
        });

        it('does not close on a click inside the picker itself', () => {
            const host = create(buildMessage());
            const trigger = host.querySelector<HTMLButtonElement>('.react-trigger')!;
            trigger.click();
            fixture.detectChanges();

            const picker = host.querySelector<HTMLElement>('.reactions-picker')!;
            picker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            fixture.detectChanges();

            expect(fixture.componentInstance.pickerOpen()).toBe(true);
        });
    });
});
