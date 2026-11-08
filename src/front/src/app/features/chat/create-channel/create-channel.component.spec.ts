import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { Chat } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { CreateChannelComponent } from './create-channel.component';

describe('CreateChannelComponent', () => {
    let fixture: ComponentFixture<CreateChannelComponent>;
    let host: HTMLElement;
    let api: jasmine.SpyObj<ChatApiService>;

    beforeEach(async () => {
        api = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['createChannel']);
        api.createChannel.and.returnValue(of({ id: 'c1' } as Chat));

        await TestBed.configureTestingModule({
            imports: [CreateChannelComponent],
            providers: [
                { provide: ChatApiService, useValue: api },
                { provide: DirectoryService, useValue: jasmine.createSpyObj('DirectoryService', ['search']) },
                { provide: ChatStoreService, useValue: { loadChats: () => Promise.resolve() } },
                { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(CreateChannelComponent);
        fixture.detectChanges();
        await fixture.whenStable();
        host = fixture.nativeElement as HTMLElement;
    });

    const submit = () => host.querySelector<HTMLButtonElement>('button.submit')!;

    function type(input: HTMLInputElement, value: string): void {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        fixture.detectChanges();
    }

    it('starts disabled with a visible reason and marks the name as required', () => {
        expect(submit().disabled).toBeTrue();
        expect(host.querySelector('.hint')?.textContent).toContain('name');
        expect(host.querySelector('label[for="title"]')?.classList).toContain('required');
        expect(host.querySelector('#title')?.getAttribute('aria-required')).toBe('true');
    });

    it('enables Create once a name is typed and sends the request', async () => {
        type(host.querySelector<HTMLInputElement>('#title')!, 'News');
        expect(submit().disabled).toBeFalse();

        submit().click();
        await fixture.whenStable();
        expect(api.createChannel).toHaveBeenCalledWith('News', '', []);
    });

    it('enables Create when the name is built by inserting an emoji with the picker button', async () => {
        host.querySelector<HTMLButtonElement>('app-emoji-button .emoji-trigger')!.click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        const emoji = document.body.querySelector<HTMLButtonElement>('app-emoji-picker button.emoji');
        expect(emoji).withContext('picker rendered in body').not.toBeNull();
        emoji!.click();
        fixture.detectChanges();

        expect(host.querySelector<HTMLInputElement>('#title')!.value.length).toBeGreaterThan(0);
        expect(submit().disabled).toBeFalse();

        submit().click();
        await fixture.whenStable();
        expect(api.createChannel).toHaveBeenCalledTimes(1);
    });
});
