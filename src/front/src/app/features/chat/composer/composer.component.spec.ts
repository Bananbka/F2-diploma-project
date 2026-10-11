import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MessageAttachment } from '../../../core/models/crypto.model';
import { ProfileApiService } from '../../../core/services/profile-api.service';
import { ComposerComponent } from './composer.component';

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

    beforeEach(() => {
        TestBed.configureTestingModule({
            imports: [ComposerComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                { provide: ProfileApiService, useValue: jasmine.createSpyObj('ProfileApiService', ['upload']) },
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
});
