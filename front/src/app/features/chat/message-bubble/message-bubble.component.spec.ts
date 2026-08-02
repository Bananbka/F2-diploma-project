import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChatApiService } from '../../../core/services/chat-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { DecryptedMessage, DecryptStatus } from '../../../core/services/message.service';
import { MessageBubbleComponent } from './message-bubble.component';

const ALL_STATUSES: DecryptStatus[] = ['ok', 'no_key', 'unverified', 'failed', 'plaintext', 'legacy'];

function message(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'm1',
        chatId: 'c1',
        senderId: 'peer',
        createdAt: '2026-01-01T10:00:00Z',
        text: 'hello',
        status: 'ok',
        isEdited: false,
        replyToId: null,
        attachments: [],
        senderVerified: false,
        ...overrides,
    };
}

describe('MessageBubbleComponent', () => {
    let fixture: ComponentFixture<MessageBubbleComponent>;

    beforeEach(async () => {
        const directory = jasmine.createSpyObj<DirectoryService>('DirectoryService', ['isMe', 'lookup']);
        directory.isMe.and.returnValue(false);
        directory.lookup.and.returnValue({
            userId: 'peer',
            name: 'Alice',
            username: 'alice',
            avatarUrl: null,
            resolved: true,
        });

        await TestBed.configureTestingModule({
            imports: [MessageBubbleComponent],
            providers: [
                { provide: DirectoryService, useValue: directory },
                {
                    provide: ChatApiService,
                    useValue: jasmine.createSpyObj<ChatApiService>('ChatApiService', ['attachmentUrl']),
                },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(MessageBubbleComponent);
    });

    function renderWith(status: DecryptStatus, text: string | null = 'hello'): HTMLElement {
        fixture.componentRef.setInput('message', message({ status, text }));
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    /**
     * The core guarantee of docs/ui-states.md: collapsing these makes the interface lie about the
     * security guarantee. The `Record<DecryptStatus, StatusView>` type already makes a *missing*
     * status a compile error; this asserts what the type cannot — that they are distinguishable.
     */
    it('renders every decrypt status distinguishably', () => {
        const tones = new Set<string>();

        for (const status of ALL_STATUSES) {
            renderWith(status, status === 'ok' || status === 'plaintext' ? 'hello' : null);
            // The tone lives on the host element, which is the component itself.
            tones.add((fixture.nativeElement as HTMLElement).getAttribute('data-tone') ?? 'missing');
        }

        // ok and plaintext deliberately share the ordinary treatment; the four unreadable states
        // must each look like themselves.
        expect(tones.size).toBeGreaterThanOrEqual(5);
        expect(tones.has('missing')).toBeFalse();
    });

    it('never shows the verified mark unless a signature actually passed', () => {
        fixture.componentRef.setInput('message', message({ status: 'ok', senderVerified: false }));
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).querySelector('.mark.is-ok')).toBeNull();

        fixture.componentRef.setInput('message', message({ status: 'ok', senderVerified: true }));
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).querySelector('.mark.is-ok')).not.toBeNull();
    });

    /** An unverified signature must never render as ordinary text — the content may be forged. */
    it('explains why an unverified message is not trustworthy', () => {
        const host = renderWith('unverified');
        expect(host.textContent).toContain('Signature did not verify');
    });

    /** `failed` must not look like a blank message; the reason has to be legible. */
    it('explains a decryption failure rather than rendering nothing', () => {
        const host = renderWith('failed', null);
        expect(host.textContent).toContain('Could not be decrypted');
    });

    /** `legacy` is permanently unreadable, so it must not imply loading. */
    it('states that a legacy message is permanently unreadable', () => {
        const host = renderWith('legacy', null);
        expect(host.textContent).toContain('Permanently unreadable');
    });

    /** A plaintext message carries no confidentiality, so it must not show a lock. */
    it('marks a plaintext message as signed-not-encrypted', () => {
        const host = renderWith('plaintext');
        expect(host.querySelector('.mark.is-warn')).not.toBeNull();
    });

    /** Right-click is the primary way in, so it must suppress the browser menu and report where. */
    it('requests the actions menu on right-click and suppresses the browser one', () => {
        fixture.componentRef.setInput('message', message());
        fixture.detectChanges();

        const requests: { x: number; y: number }[] = [];
        fixture.componentInstance.menuRequested.subscribe((request) => requests.push(request));

        const event = new MouseEvent('contextmenu', { clientX: 120, clientY: 240, cancelable: true });
        (fixture.nativeElement as HTMLElement).dispatchEvent(event);

        expect(event.defaultPrevented).toBeTrue();
        expect(requests).toEqual([jasmine.objectContaining({ x: 120, y: 240 })]);
    });

    /** Touch has no right button, so the overflow control must reach the same menu. */
    it('requests the actions menu from the overflow button', () => {
        fixture.componentRef.setInput('message', message());
        fixture.detectChanges();

        let asked = false;
        fixture.componentInstance.menuRequested.subscribe(() => (asked = true));

        (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.action')?.click();

        expect(asked).toBeTrue();
    });

    /** Telegram's gesture. Suppressing the default keeps a stray word-selection off the screen. */
    it('replies on double-click and suppresses the word selection', () => {
        fixture.componentRef.setInput('message', message());
        fixture.detectChanges();

        const replied: string[] = [];
        fixture.componentInstance.replyRequested.subscribe((m) => replied.push(m.id));

        const event = new MouseEvent('dblclick', { cancelable: true });
        (fixture.nativeElement as HTMLElement).dispatchEvent(event);

        expect(replied).toEqual(['m1']);
        expect(event.defaultPrevented).toBeTrue();
    });

    /** While picking messages, a double-click must not fire a reply behind the selection. */
    it('does not reply on double-click while selecting', () => {
        fixture.componentRef.setInput('message', message());
        fixture.componentRef.setInput('selecting', true);
        fixture.detectChanges();

        let replied = false;
        fixture.componentInstance.replyRequested.subscribe(() => (replied = true));

        (fixture.nativeElement as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { cancelable: true }));

        expect(replied).toBeFalse();
    });

    it('toggles selection on a plain click only while selecting', () => {
        fixture.componentRef.setInput('message', message());
        fixture.detectChanges();

        const toggled: string[] = [];
        fixture.componentInstance.selectionToggled.subscribe((id) => toggled.push(id));

        (fixture.nativeElement as HTMLElement).click();
        expect(toggled).toEqual([]);

        fixture.componentRef.setInput('selecting', true);
        fixture.detectChanges();
        (fixture.nativeElement as HTMLElement).click();

        expect(toggled).toEqual(['m1']);
    });

    it('does not offer editing for a message it could not open', () => {
        fixture.componentRef.setInput('message', message({ status: 'failed', text: null }));
        fixture.detectChanges();
        expect(fixture.componentInstance.canEdit()).toBeFalse();
    });
});
