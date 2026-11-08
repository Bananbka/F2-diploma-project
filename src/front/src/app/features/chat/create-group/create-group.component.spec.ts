import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { CreateGroupComponent } from './create-group.component';

describe('CreateGroupComponent', () => {
    let fixture: ComponentFixture<CreateGroupComponent>;
    let host: HTMLElement;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [CreateGroupComponent],
            providers: [
                { provide: ChatApiService, useValue: jasmine.createSpyObj('ChatApiService', ['createGroupChat']) },
                { provide: CryptoApiService, useValue: {} },
                { provide: DirectoryService, useValue: jasmine.createSpyObj('DirectoryService', ['search']) },
                { provide: ChatStoreService, useValue: { loadChats: () => Promise.resolve() } },
                { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
            ],
        }).compileComponents();
        fixture = TestBed.createComponent(CreateGroupComponent);
        fixture.detectChanges();
        host = fixture.nativeElement as HTMLElement;
    });

    it('reacts to typing and a selected member, and explains why it is disabled', () => {
        const submit = host.querySelector<HTMLButtonElement>('button.submit')!;
        const title = host.querySelector<HTMLInputElement>('#title')!;
        expect(submit.disabled).toBeTrue();
        expect(host.querySelector('.hint')?.textContent).toContain('name');

        title.value = 'Team';
        title.dispatchEvent(new Event('input', { bubbles: true }));
        fixture.detectChanges();
        expect(submit.disabled).toBeTrue();
        expect(host.querySelector('.hint')?.textContent).toContain('member');

        fixture.componentInstance.toggle({ id: 'u1', full_name: 'Ann', username: 'ann', avatar_url: null } as never);
        fixture.detectChanges();
        expect(submit.disabled).toBeFalse();
        expect(host.querySelector('.hint')).toBeNull();
    });
});
