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
});
