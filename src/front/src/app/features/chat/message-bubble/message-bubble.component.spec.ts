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

    describe('appearance custom properties', () => {
        it('uses --bubble-own-bg on an outgoing bubble', () => {
            (TestBed.inject(DirectoryService).isMe as jasmine.Spy).and.returnValue(true);
            const host = create(buildMessage());
            host.style.setProperty('--bubble-own-bg', '#123456');
            host.style.setProperty('--bubble-own-fg', '#ffffff');

            const style = getComputedStyle(host.querySelector('.bubble') as HTMLElement);
            expect(style.backgroundColor).toBe('rgb(18, 52, 86)');
        });

        it('uses --bubble-other-bg on an incoming bubble and falls back without it', () => {
            const host = create(buildMessage());
            const bubble = host.querySelector('.bubble') as HTMLElement;
            const before = getComputedStyle(bubble).backgroundColor;

            host.style.setProperty('--bubble-other-bg', '#654321');
            expect(getComputedStyle(bubble).backgroundColor).toBe('rgb(101, 67, 33)');
            host.style.removeProperty('--bubble-other-bg');
            expect(getComputedStyle(bubble).backgroundColor).toBe(before);
        });

        it('scales message text with --chat-font-scale', () => {
            const host = create(buildMessage());
            const text = host.querySelector('.text') as HTMLElement;
            const base = parseFloat(getComputedStyle(text).fontSize);

            host.style.setProperty('--chat-font-scale', '2');
            expect(parseFloat(getComputedStyle(text).fontSize)).toBeCloseTo(base * 2, 1);
        });
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

    describe('footer is a single row', () => {
        function footerOf(host: HTMLElement): HTMLElement {
            return host.querySelector<HTMLElement>('.meta')!;
        }

        function expectOneFooterRow(host: HTMLElement): void {
            const footer = footerOf(host);
            expect(footer.querySelector('.react-trigger')).not.toBeNull();
            expect(footer.querySelector('.time')).not.toBeNull();
            expect(footer.querySelector('button.action')).not.toBeNull();
            // With no reactions there is no separate chip row above it.
            expect(host.querySelector('.reactions')).toBeNull();
            expect(host.querySelectorAll('.react-trigger').length).toBe(1);
        }

        it('puts add-reaction, actions and time in the same row for a text message', () => {
            expectOneFooterRow(create(buildMessage()));
        });

        it('does the same for a sticker, image, voice and file message', () => {
            const kinds: Partial<MessageAttachment>[] = [
                { kind: 'sticker', content_type: 'image/webp' },
                { kind: 'image' },
                { kind: 'audio', content_type: 'audio/webm' },
                { kind: 'file', content_type: 'application/pdf', name: 'a.pdf' },
            ];
            for (const attachment of kinds) {
                const host = create(buildMessage({ text: '', attachments: [buildAttachment(attachment)] }));
                expectOneFooterRow(host);
            }
        });

        it('keeps the tick in the same row for our own message', () => {
            (TestBed.inject(DirectoryService).isMe as jasmine.Spy).and.returnValue(true);
            const host = create(buildMessage({ senderId: 'me' }));

            const footer = footerOf(host);
            expect(footer.querySelector('.receipt')).not.toBeNull();
            expect(footer.querySelector('.react-trigger')).not.toBeNull();
        });

        it('renders chips in their own row only when reactions exist, with the add control still in the footer', () => {
            const host = create(
                buildMessage({ reactions: [{ emoji: '👍', user_id: 'u1', created_at: '2024-01-01T00:00:00Z' }] })
            );

            expect(host.querySelectorAll('.reactions .reaction-pill').length).toBe(1);
            expect(host.querySelector('.reactions .react-trigger')).toBeNull();
            expect(footerOf(host).querySelector('.react-trigger')).not.toBeNull();
        });

        it('places the reaction chips below the time/status footer, not above it', () => {
            const host = create(
                buildMessage({ reactions: [{ emoji: '👍', user_id: 'u1', created_at: '2024-01-01T00:00:00Z' }] })
            );

            const footer = footerOf(host);
            const chips = host.querySelector('.reactions')!;
            expect(footer.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('keeps the accessible names', () => {
            const host = create(buildMessage());

            expect(host.querySelector('.react-trigger')?.getAttribute('aria-label')).toBe('Add a reaction');
            expect(host.querySelector('button.action')?.getAttribute('aria-label')).toBe('Actions for this message');
        });
    });
});
