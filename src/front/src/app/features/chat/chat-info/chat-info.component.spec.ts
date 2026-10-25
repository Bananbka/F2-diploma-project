import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';

import { Chat, InviteLink } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { ContactsApiService } from '../../../core/services/contacts-api.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { SessionService } from '../../../core/services/session.service';
import { ChatInfoComponent } from './chat-info.component';

const CHAT_ID = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

const CHAT: Chat = {
    id: CHAT_ID,
    chat_type: 'group',
    title: 'Test group',
    avatar_url: null,
    unread_count: 0,
    last_message: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: null,
    participants: [{ user_id: OWNER_ID, role: 'owner', joined_at: '2024-01-01T00:00:00Z' }],
    muted_until: null,
    is_muted: false,
};

function makeLink(id: string, token: string): InviteLink {
    return {
        id,
        chat_id: CHAT_ID,
        token,
        created_by: OWNER_ID,
        created_at: '2024-01-01T00:00:00Z',
        expires_at: null,
        max_uses: null,
        use_count: 0,
        revoked_at: null,
        is_active: true,
    };
}

describe('ChatInfoComponent', () => {
    let fixture: ComponentFixture<ChatInfoComponent>;
    let chatApi: jasmine.SpyObj<ChatApiService>;
    const linkA = makeLink('link-a', 'token-a');
    const linkB = makeLink('link-b', 'token-b');

    beforeEach(async () => {
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', [
            'getChat',
            'listInviteLinks',
            'revokeInviteLink',
            'createInviteLink',
        ]);
        chatApi.getChat.and.returnValue(of(CHAT));
        chatApi.listInviteLinks.and.returnValue(of([linkA, linkB]));
        chatApi.revokeInviteLink.and.returnValue(
            of({ ...linkA, is_active: false, revoked_at: '2024-01-02T00:00:00Z' })
        );

        const cryptoApi = jasmine.createSpyObj<CryptoApiService>('CryptoApiService', ['getRoster', 'getSafetyNumber']);
        cryptoApi.getRoster.and.returnValue(throwError(() => new Error('no roster in test')));
        cryptoApi.getSafetyNumber.and.returnValue(throwError(() => new Error('no safety number in test')));

        const directory = jasmine.createSpyObj<DirectoryService>('DirectoryService', [
            'lookup',
            'rememberPrivateChatPeer',
            'search',
            'warm',
        ]);
        directory.lookup.and.returnValue({
            userId: OWNER_ID,
            name: 'Owner',
            username: 'owner',
            avatarUrl: null,
            resolved: true,
        });

        const contactsApi = jasmine.createSpyObj<ContactsApiService>('ContactsApiService', ['addContact']);

        const session = { user: () => ({ id: OWNER_ID }) } as unknown as SessionService;
        const store = {
            chats: () => [],
            activeChatId: { set: () => {} },
            loadChats: async () => {},
            setMuted: async () => {},
        } as unknown as ChatStoreService;

        await TestBed.configureTestingModule({
            imports: [ChatInfoComponent],
            providers: [
                { provide: ChatApiService, useValue: chatApi },
                { provide: CryptoApiService, useValue: cryptoApi },
                { provide: DirectoryService, useValue: directory },
                { provide: ContactsApiService, useValue: contactsApi },
                { provide: SessionService, useValue: session },
                { provide: ChatStoreService, useValue: store },
                provideRouter([]),
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(ChatInfoComponent);
        fixture.componentRef.setInput('chatId', CHAT_ID);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
    });

    /**
     * Revoking is irreversible and shares a row with "copy", so it goes through the same two-step
     * arm/confirm signal as transferring ownership and deleting the chat, rather than firing on the
     * first click.
     */
    it('arms revoke on the first click without calling the API', async () => {
        fixture.componentInstance.revokeInviteLink(linkA);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(chatApi.revokeInviteLink).not.toHaveBeenCalled();
        expect(fixture.componentInstance.confirming()).toBe(`revoke:${linkA.id}`);

        const host = fixture.nativeElement as HTMLElement;
        expect(host.textContent).toContain('Revoke?');
    });

    it('revokes on the second click of the same link', async () => {
        fixture.componentInstance.revokeInviteLink(linkA);
        fixture.detectChanges();
        await fixture.whenStable();

        await fixture.componentInstance.revokeInviteLink(linkA);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(chatApi.revokeInviteLink).toHaveBeenCalledWith(linkA.token);
        expect(fixture.componentInstance.confirming()).toBeNull();
    });

    it('arming a different link resets which one is armed', async () => {
        fixture.componentInstance.revokeInviteLink(linkA);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.confirming()).toBe(`revoke:${linkA.id}`);

        fixture.componentInstance.revokeInviteLink(linkB);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(chatApi.revokeInviteLink).not.toHaveBeenCalled();
        expect(fixture.componentInstance.confirming()).toBe(`revoke:${linkB.id}`);
    });

    it('cancelConfirm disarms an armed revoke', async () => {
        fixture.componentInstance.revokeInviteLink(linkA);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.confirming()).toBe(`revoke:${linkA.id}`);

        fixture.componentInstance.cancelConfirm();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(fixture.componentInstance.confirming()).toBeNull();
        expect(chatApi.revokeInviteLink).not.toHaveBeenCalled();
    });

    describe('embedded in the side panel', () => {
        const PEER_ID = 'cccccccc-0000-4000-8000-000000000003';
        const PRIVATE: Chat = {
            ...CHAT,
            chat_type: 'private',
            title: null,
            participants: [
                { user_id: OWNER_ID, role: 'member', joined_at: '2024-01-01T00:00:00Z' },
                { user_id: PEER_ID, role: 'member', joined_at: '2024-01-01T00:00:00Z' },
            ],
        };

        async function openEmbedded(chat: Chat): Promise<HTMLElement> {
            chatApi.getChat.and.returnValue(of(chat));
            fixture = TestBed.createComponent(ChatInfoComponent);
            fixture.componentRef.setInput('chatId', CHAT_ID);
            fixture.componentRef.setInput('embedded', true);
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            return fixture.nativeElement as HTMLElement;
        }

        it('drops the screen header but keeps the content', async () => {
            const host = await openEmbedded(CHAT);

            expect(host.querySelector('.head')).toBeNull();
            expect(host.classList.contains('is-embedded')).toBeTrue();
            expect(host.querySelector('.profile-name')?.textContent).toContain('Test group');
        });

        it('shows the peer’s name and username in a private chat', async () => {
            const host = await openEmbedded(PRIVATE);

            expect(host.querySelector('.profile-username')?.textContent).toContain('@owner');
        });

        it('shows "Deleted user" and no username or avatar image for a deleted peer', async () => {
            const host = await openEmbedded({ ...PRIVATE, peer_is_deleted: true });

            expect(host.querySelector('.profile-name')?.textContent).toContain('Deleted user');
            expect(host.querySelector('.profile-username')).toBeNull();
            expect(host.querySelector('.profile img')).toBeNull();
        });
    });
});
