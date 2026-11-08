import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';

import { Chat, InviteLink } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { ContactsApiService } from '../../../core/services/contacts-api.service';
import { ContactsStoreService } from '../../../core/services/contacts-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
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
        sessionStorage.removeItem('chat-info-tab');
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', [
            'getChat',
            'listInviteLinks',
            'revokeInviteLink',
            'createInviteLink',
            'createPrivateChat',
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
    describe('member gates mirror the server', () => {
        const row = (role: 'owner' | 'admin' | 'member', isMe = false) =>
            ({ userId: role + isMe, name: 'x', role, isMe, hasKeys: true, deleted: false }) as never;

        it('lets only the owner change roles', () => {
            const component = fixture.componentInstance;
            spyOn(component, 'isOwner').and.returnValue(false);
            expect(component.canChangeRole(row('member'))).toBeFalse();

            (component.isOwner as unknown as jasmine.Spy).and.returnValue(true);
            expect(component.canChangeRole(row('member'))).toBeTrue();
            expect(component.canChangeRole(row('owner'))).toBeFalse();
        });

        it('removes only strictly lower ranks', () => {
            const component = fixture.componentInstance;
            const roster = (mine: 'owner' | 'admin' | 'member') => [
                row(mine, true),
                row('owner'),
                row('admin'),
                row('member'),
            ];

            spyOn(component, 'members').and.returnValue(roster('admin'));
            expect(component.canRemove(row('member'))).toBeTrue();
            expect(component.canRemove(row('admin'))).toBeFalse();
            expect(component.canRemove(row('owner'))).toBeFalse();

            (component.members as unknown as jasmine.Spy).and.returnValue(roster('owner'));
            expect(component.canRemove(row('admin'))).toBeTrue();
            expect(component.canRemove(row('member'))).toBeTrue();
            expect(component.canRemove(row('owner', true))).toBeFalse();

            (component.members as unknown as jasmine.Spy).and.returnValue(roster('member'));
            expect(component.canRemove(row('member'))).toBeFalse();
        });
    });

    it('arms revoke on the first click without calling the API', async () => {
        fixture.componentInstance.revokeInviteLink(linkA);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(chatApi.revokeInviteLink).not.toHaveBeenCalled();
        expect(fixture.componentInstance.confirming()).toBe(`revoke:${linkA.id}`);

        fixture.componentInstance.selectTab('settings');
        fixture.detectChanges();
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

    describe('tabs and member profile', () => {
        const PEER_ID = 'cccccccc-0000-4000-8000-000000000003';
        const GROUP: Chat = {
            ...CHAT,
            participants: [
                { user_id: OWNER_ID, role: 'owner', joined_at: '2024-01-01T00:00:00Z' },
                { user_id: PEER_ID, role: 'member', joined_at: '2024-01-01T00:00:00Z' },
            ],
        };
        const PRIVATE: Chat = { ...GROUP, chat_type: 'private', title: null };

        async function open(chat: Chat): Promise<HTMLElement> {
            chatApi.getChat.and.returnValue(of(chat));
            fixture = TestBed.createComponent(ChatInfoComponent);
            fixture.componentRef.setInput('chatId', CHAT_ID);
            fixture.componentRef.setInput('embedded', true);
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            return fixture.nativeElement as HTMLElement;
        }

        const tabLabels = (host: HTMLElement) =>
            Array.from(host.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.trim());

        it('offers Members, Settings and Data for a group', async () => {
            const host = await open(GROUP);
            expect(tabLabels(host)).toEqual(['Members', 'Encryption', 'Settings', 'Data']);
            expect(host.querySelector('.members')).not.toBeNull();
            expect(host.querySelector('.invite-create')).toBeNull();
        });

        it('a group has an Encryption tab; a private chat keeps its Encryption card on Profile', async () => {
            const group = await open(GROUP);
            fixture.componentInstance.selectTab('encryption');
            fixture.detectChanges();
            expect(group.querySelector('app-encryption-panel')).not.toBeNull();
            const privateHost = await open(PRIVATE);
            expect(tabLabels(privateHost)).not.toContain('Encryption');
            expect(
                Array.from(privateHost.querySelectorAll('.section')).some((e) => e.textContent?.trim() === 'Encryption')
            ).toBeTrue();
        });

        it('openSafetyFor opens that member safety number inline, as the member profile does', async () => {
            await open(GROUP);
            fixture.componentInstance.openSafetyFor(PEER_ID);
            expect(fixture.componentInstance.selectedMemberId()).toBe(PEER_ID);
            expect(fixture.componentInstance.safetyOpen()).toBeTrue();
        });

        it('after a reload, a preloaded contact shows as saved instead of offering Save', async () => {
            TestBed.inject(ContactsStoreService).contacts.set([
                {
                    owner_id: OWNER_ID,
                    contact_id: PEER_ID,
                    alias_name: null,
                    user: { id: PEER_ID, full_name: 'Zed A', username: 'za', avatar_url: null },
                },
            ]);
            const host = await open(PRIVATE);
            expect(host.querySelector('.saved-note')?.textContent).toContain('Saved as a contact');
            expect(host.textContent).not.toContain('Save as contact');
            expect(Array.from(host.querySelectorAll('.saved-actions .link')).map((b) => b.textContent?.trim())).toEqual(
                ['Rename', 'Remove']
            );
        });

        it('offers Save as contact when the peer is not in the store', async () => {
            TestBed.inject(ContactsStoreService).contacts.set([]);
            const host = await open(PRIVATE);
            expect(host.textContent).toContain('Save as contact');
            expect(host.querySelector('.saved-note')).toBeNull();
        });

        it('shows the private chat peer picture in the header, monogram only as the fallback', async () => {
            const host = await open({ ...PRIVATE, avatar_url: 'https://files.test/zed.webp' });
            expect(fixture.componentInstance.headerAvatarUrl()).toBe('https://files.test/zed.webp');
            expect(host.querySelector('app-avatar img')?.getAttribute('src')).toBe('https://files.test/zed.webp');
        });

        it('offers Profile, Settings and Data for a private chat, without a member list', async () => {
            const host = await open(PRIVATE);
            expect(tabLabels(host)).toEqual(['Profile', 'Settings', 'Data']);
            expect(host.querySelector('.members')).toBeNull();
        });

        it('moves between tabs with the arrow keys and remembers the choice for the session', async () => {
            const host = await open(GROUP);
            const first = host.querySelector<HTMLElement>('#chat-info-tab-main')!;
            first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            host.querySelector<HTMLElement>('#chat-info-tab-encryption')!.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
            );
            fixture.detectChanges();

            expect(fixture.componentInstance.tab()).toBe('settings');
            expect(sessionStorage.getItem('chat-info-tab')).toBe('settings');
            expect(host.querySelector('.invite-create')).not.toBeNull();

            const again = await open(GROUP);
            expect(again.querySelector('#chat-info-tab-settings')?.getAttribute('aria-selected')).toBe('true');
        });

        it('keeps leave and delete off the Members and Settings tabs', async () => {
            const host = await open(GROUP);
            expect(host.querySelector('.danger-row')).toBeNull();

            fixture.componentInstance.selectTab('data');
            fixture.detectChanges();
            expect(host.querySelectorAll('.danger-row').length).toBe(2);
        });

        it('opens a member profile on click and goes back to the list', async () => {
            const host = await open(GROUP);
            const rows = host.querySelectorAll<HTMLButtonElement>('button.member');
            expect(rows.length).toBe(2);

            rows[1].click();
            fixture.detectChanges();

            expect(host.querySelector('.member-view')).not.toBeNull();
            expect(host.querySelector('[role="tablist"]')).toBeNull();
            expect(host.querySelector('.member-view')?.textContent).toContain('Save as contact');
            expect(host.querySelector('.member-view')?.textContent).toContain('Message');
            // The viewer owns the chat, so the RBAC controls for a plain member are offered.
            expect(host.querySelector('.member-view')?.textContent).toContain('Remove from chat');

            host.querySelector<HTMLButtonElement>('.sub-back')!.click();
            fixture.detectChanges();
            expect(host.querySelector('.member-view')).toBeNull();
            expect(host.querySelector('[role="tablist"]')).not.toBeNull();
        });

        it('offers no contact, message or removal actions on your own profile', async () => {
            const host = await open(GROUP);
            host.querySelector<HTMLButtonElement>('button.member')!.click();
            fixture.detectChanges();

            const text = host.querySelector('.member-view')!.textContent!;
            expect(text).not.toContain('Save as contact');
            expect(text).not.toContain('Remove from chat');
        });

        it('shows a failed action inline and keeps the panel, instead of replacing it', async () => {
            const host = await open(GROUP);
            chatApi.createPrivateChat.and.returnValue(throwError(() => new Error('no')));
            host.querySelectorAll<HTMLButtonElement>('button.member')[1].click();
            fixture.detectChanges();
            Array.from(host.querySelectorAll<HTMLButtonElement>('.member-view button.tile'))
                .find((b) => b.textContent?.includes('Message'))!
                .click();
            await fixture.whenStable();
            fixture.detectChanges();

            expect(host.querySelector('.action-error')?.textContent).toContain('Could not open a chat');
            expect(host.querySelector('.member-view')).not.toBeNull();
            expect(fixture.componentInstance.error()).toBeNull();

            host.querySelector<HTMLButtonElement>('.action-error button')!.click();
            fixture.detectChanges();
            expect(host.querySelector('.action-error')).toBeNull();
        });

        it('clears an action error when the tab or the member changes', async () => {
            const host = await open(GROUP);
            fixture.componentInstance.actionError.set('x');
            fixture.componentInstance.selectTab('settings');
            expect(fixture.componentInstance.actionError()).toBeNull();

            fixture.componentInstance.actionError.set('x');
            fixture.componentInstance.openMember(fixture.componentInstance.members()[1]);
            expect(fixture.componentInstance.actionError()).toBeNull();
            expect(host).toBeTruthy();
        });

        it('offers a retry when the load itself fails', async () => {
            chatApi.getChat.and.returnValue(throwError(() => new Error('down')));
            fixture = TestBed.createComponent(ChatInfoComponent);
            fixture.componentRef.setInput('chatId', CHAT_ID);
            fixture.componentRef.setInput('embedded', true);
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            const host = fixture.nativeElement as HTMLElement;
            expect(host.querySelector('.error')?.textContent).toContain('Could not load');

            chatApi.getChat.and.returnValue(of(GROUP));
            host.querySelector<HTMLButtonElement>('.retry')!.click();
            await fixture.whenStable();
            fixture.detectChanges();
            expect(host.querySelector('.error')).toBeNull();
            expect(host.querySelector('.members')).not.toBeNull();
        });

        it('goes back on Escape inside a member profile without the panel seeing it, and refocuses the row', async () => {
            const host = await open(GROUP);
            const row = host.querySelectorAll<HTMLButtonElement>('button.member')[1];
            row.focus();
            row.click();
            fixture.detectChanges();
            await fixture.whenStable();
            expect(document.activeElement).toBe(host.querySelector('.sub-back'));

            const seen = jasmine.createSpy('document');
            document.addEventListener('keydown', seen);
            const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            host.querySelector('.sub-back')!.dispatchEvent(event);
            fixture.detectChanges();
            await fixture.whenStable();
            document.removeEventListener('keydown', seen);

            expect(event.defaultPrevented).toBeTrue();
            expect(seen).not.toHaveBeenCalled();
            expect(host.querySelector('.member-view')).toBeNull();
            expect(document.activeElement).toBe(host.querySelectorAll('button.member')[1]);
        });

        it('still navigates to the new chat when refreshing the list fails', async () => {
            const host = await open(GROUP);
            const store = TestBed.inject(ChatStoreService) as unknown as { loadChats: () => Promise<void> };
            store.loadChats = () => Promise.reject(new Error('down'));
            chatApi.createPrivateChat.and.returnValue(of({ ...CHAT, id: 'dm-2', chat_type: 'private' }));
            const router = TestBed.inject(Router);
            spyOn(router, 'navigate').and.resolveTo(true);

            await fixture.componentInstance.messageMember(fixture.componentInstance.members()[1]);

            expect(router.navigate).toHaveBeenCalledWith(['/chats', 'dm-2']);
            expect(host).toBeTruthy();
        });

        it('keeps the profile open when removing the member fails', async () => {
            await open(GROUP);
            (chatApi as unknown as { removeParticipants: jasmine.Spy }).removeParticipants = jasmine
                .createSpy()
                .and.returnValue(throwError(() => new Error('no')));
            const component = fixture.componentInstance;
            component.openMember(component.members()[1]);

            expect(await component.removeMember(PEER_ID)).toBeFalse();
            expect(component.selectedMemberId()).not.toBeNull();
            expect(component.actionError()).toContain('Could not remove');
        });

        it('opens or creates a private chat from the Message action', async () => {
            const host = await open(GROUP);
            chatApi.createPrivateChat.and.returnValue(of({ ...CHAT, id: 'dm-1', chat_type: 'private' }));
            const router = TestBed.inject(Router);
            spyOn(router, 'navigate').and.resolveTo(true);

            host.querySelectorAll<HTMLButtonElement>('button.member')[1].click();
            fixture.detectChanges();
            const message = Array.from(host.querySelectorAll<HTMLButtonElement>('.member-view button.tile')).find((b) =>
                b.textContent?.includes('Message')
            )!;
            message.click();
            await fixture.whenStable();

            expect(chatApi.createPrivateChat).toHaveBeenCalledWith(PEER_ID);
            expect(router.navigate).toHaveBeenCalledWith(['/chats', 'dm-1']);
        });
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

    describe('safety number inline and state restoration', () => {
        const PEER_ID = 'cccccccc-0000-4000-8000-000000000003';
        const NUMBER = '12345 67890 12345 67890 12345 67890';
        const GROUP: Chat = {
            ...CHAT,
            participants: [
                { user_id: OWNER_ID, role: 'owner', joined_at: '2024-01-01T00:00:00Z' },
                { user_id: PEER_ID, role: 'member', joined_at: '2024-01-01T00:00:00Z' },
            ],
        };
        let cryptoApi: jasmine.SpyObj<CryptoApiService>;

        const rosterOf = (ids: string[]) =>
            of({
                chat_id: CHAT_ID,
                current_epoch: 1,
                member_set_hash: 'h',
                members: ids.map((user_id) => ({
                    user_id,
                    device_id: 'd',
                    identity_key_id: 'k',
                    identity_public_key: 'AAAA',
                    signing_public_key: 'AAAA',
                    identity_key_signature: 'AAAA',
                    signed_prekey_public: null,
                    signed_prekey_signature: null,
                })),
            } as never);

        beforeEach(() => {
            cryptoApi = TestBed.inject(CryptoApiService) as jasmine.SpyObj<CryptoApiService>;
            cryptoApi.getRoster.and.returnValue(rosterOf([OWNER_ID, PEER_ID]) as never);
            chatApi.getChat.and.returnValue(of(GROUP));
            // The embedded view derives the number locally; stub the key store it asks.
            spyOn(TestBed.inject(KeyStoreService), 'computeSafetyNumber').and.resolveTo(NUMBER);
        });

        async function mount(chatId = CHAT_ID): Promise<HTMLElement> {
            fixture = TestBed.createComponent(ChatInfoComponent);
            fixture.componentRef.setInput('chatId', chatId);
            fixture.componentRef.setInput('embedded', true);
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            return fixture.nativeElement as HTMLElement;
        }

        async function settle(): Promise<void> {
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
        }

        const peerRow = (host: HTMLElement) => host.querySelector<HTMLElement>(`[data-member-id="${PEER_ID}"]`)!;

        it('opens the safety number inline and goes back to the member profile', async () => {
            const router = TestBed.inject(Router);
            const navigate = spyOn(router, 'navigate');
            const host = await mount();

            peerRow(host).click();
            await settle();
            const tile = Array.from(host.querySelectorAll<HTMLElement>('.tile')).find((t) =>
                t.textContent?.includes('Safety number')
            )!;
            tile.click();
            await settle();

            expect(host.querySelector('app-safety-number')).not.toBeNull();
            expect(host.querySelector('app-safety-number .head')).toBeNull();
            expect(host.querySelector('app-safety-number .full-value')?.textContent).toContain(NUMBER);
            expect(navigate).not.toHaveBeenCalled();

            host.querySelector<HTMLElement>('.sub-back')!.click();
            await settle();

            expect(host.querySelector('app-safety-number')).toBeNull();
            expect(host.querySelector('.profile-name')).not.toBeNull();
        });

        it('restores tab, member and safety sub-view after the component is destroyed and recreated', async () => {
            let host = await mount();
            peerRow(host).click();
            await settle();
            fixture.componentInstance.openSafety(fixture.componentInstance.selectedMember()!);
            await settle();
            fixture.destroy();

            host = await mount();

            expect(fixture.componentInstance.selectedMemberId()).toBe(PEER_ID);
            expect(fixture.componentInstance.safetyOpen()).toBeTrue();
            expect(host.querySelector('app-safety-number')).not.toBeNull();
        });

        it('restores the selected tab', async () => {
            await mount();
            fixture.componentInstance.selectTab('settings');
            await settle();
            fixture.destroy();
            sessionStorage.removeItem('chat-info-tab');

            await mount();

            expect(fixture.componentInstance.tab()).toBe('settings');
        });

        it('drops a remembered member who is no longer in the chat', async () => {
            const host = await mount();
            peerRow(host).click();
            await settle();
            fixture.destroy();

            chatApi.getChat.and.returnValue(of({ ...GROUP, participants: [GROUP.participants[0]] }));
            await mount();

            expect(fixture.componentInstance.selectedMemberId()).toBeNull();
            expect(fixture.componentInstance.safetyOpen()).toBeFalse();
        });

        it('starts a different chat from the default', async () => {
            const host = await mount();
            peerRow(host).click();
            await settle();
            fixture.destroy();
            sessionStorage.removeItem('chat-info-tab');

            const OTHER = 'a0000000-0000-4000-8000-000000000009';
            chatApi.getChat.and.returnValue(of({ ...GROUP, id: OTHER }));
            await mount(OTHER);

            expect(fixture.componentInstance.selectedMemberId()).toBeNull();
            expect(fixture.componentInstance.tab()).toBe('main');
        });
    });
});
