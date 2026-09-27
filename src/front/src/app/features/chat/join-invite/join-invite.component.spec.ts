import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

import { Chat, InviteLinkPreview } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { JoinInviteComponent } from './join-invite.component';

const TOKEN = 'a-shareable-token';
const CHAT = 'a0000000-0000-4000-8000-000000000001';

function preview(overrides: Partial<InviteLinkPreview> = {}): InviteLinkPreview {
    return {
        chat_id: CHAT,
        chat_type: 'group',
        title: 'Dev Team',
        avatar_url: null,
        member_count: 4,
        ...overrides,
    };
}

function chat(id: string): Chat {
    return {
        id,
        chat_type: 'group',
        title: 'Dev Team',
        avatar_url: null,
        unread_count: 0,
        last_message: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
        participants: [],
        muted_until: null,
        is_muted: false,
    };
}

describe('JoinInviteComponent', () => {
    let fixture: ComponentFixture<JoinInviteComponent>;
    let chatApi: jasmine.SpyObj<ChatApiService>;
    let store: { chats: jasmine.Spy; loadChats: jasmine.Spy };
    let router: jasmine.SpyObj<Router>;
    let chatsValue: Chat[];

    async function render(): Promise<HTMLElement> {
        fixture.componentRef.setInput('token', TOKEN);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['previewInviteLink', 'joinInviteLink']);
        chatsValue = [];
        store = {
            chats: jasmine.createSpy('chats').and.callFake(() => chatsValue),
            loadChats: jasmine.createSpy('loadChats').and.resolveTo(),
        };
        router = jasmine.createSpyObj<Router>('Router', ['navigate']);
        router.navigate.and.resolveTo(true);

        await TestBed.configureTestingModule({
            imports: [JoinInviteComponent],
            providers: [
                { provide: ChatApiService, useValue: chatApi },
                { provide: ChatStoreService, useValue: store },
                { provide: Router, useValue: router },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(JoinInviteComponent);
    });

    it('shows a loading state before the preview resolves', () => {
        chatApi.previewInviteLink.and.returnValue(of(preview()));
        fixture.componentRef.setInput('token', TOKEN);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('Loading invite');
    });

    it('renders the chat preview and a Join button for a valid, not-yet-joined link', async () => {
        chatApi.previewInviteLink.and.returnValue(of(preview()));

        const el = await render();

        expect(el.textContent).toContain('Dev Team');
        expect(el.textContent).toContain('4 members');
        expect(el.textContent).toContain('Join');
        expect(el.textContent).not.toContain("You're already in this chat");
    });

    it('shows an invalid-link state on a 404', async () => {
        chatApi.previewInviteLink.and.returnValue(throwError(() => new HttpErrorResponse({ status: 404 })));

        const el = await render();

        expect(el.textContent).toContain('invalid or has expired');
    });

    it('shows an invalid-link state on a 410 (revoked/expired)', async () => {
        chatApi.previewInviteLink.and.returnValue(throwError(() => new HttpErrorResponse({ status: 410 })));

        const el = await render();

        expect(el.textContent).toContain('invalid or has expired');
    });

    it('offers "Open chat" instead of "Join" when the chat is already in the store', async () => {
        chatsValue = [chat(CHAT)];
        chatApi.previewInviteLink.and.returnValue(of(preview()));

        const el = await render();

        expect(el.textContent).toContain("You're already in this chat");
        expect(el.textContent).toContain('Open chat');
    });

    it('navigates straight into the chat on join for an already-joined preview, without calling the join API', async () => {
        chatsValue = [chat(CHAT)];
        chatApi.previewInviteLink.and.returnValue(of(preview()));
        const el = await render();

        el.querySelector<HTMLButtonElement>('.submit')!.click();
        await fixture.whenStable();

        expect(chatApi.joinInviteLink).not.toHaveBeenCalled();
        expect(router.navigate).toHaveBeenCalledWith(['/chats', CHAT]);
    });

    it('joins and navigates into the chat on success', async () => {
        chatApi.previewInviteLink.and.returnValue(of(preview()));
        chatApi.joinInviteLink.and.returnValue(of({ chat_id: CHAT, already_member: false }));
        const el = await render();

        el.querySelector<HTMLButtonElement>('.submit')!.click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(chatApi.joinInviteLink).toHaveBeenCalledWith(TOKEN);
        expect(store.loadChats).toHaveBeenCalled();
        expect(router.navigate).toHaveBeenCalledWith(['/chats', CHAT]);
    });

    it('surfaces an error and stays on the screen when joining fails', async () => {
        chatApi.previewInviteLink.and.returnValue(of(preview()));
        chatApi.joinInviteLink.and.returnValue(throwError(() => new HttpErrorResponse({ status: 410 })));
        const el = await render();

        el.querySelector<HTMLButtonElement>('.submit')!.click();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(router.navigate).not.toHaveBeenCalled();
        expect(fixture.nativeElement.textContent).toContain('invalid or has expired');
    });
});
