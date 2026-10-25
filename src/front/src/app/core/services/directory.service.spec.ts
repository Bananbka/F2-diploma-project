import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { Contact, UserProfile, UserSearchResult } from '../models/chat.model';
import { ChatApiService } from './chat-api.service';
import { ContactsApiService } from './contacts-api.service';
import { DirectoryService } from './directory.service';
import { SessionService } from './session.service';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const PEER = 'bbbbbbbb-0000-4000-8000-000000000002';
const STRANGER = 'cccccccc-0000-4000-8000-000000000003';

function contact(id: string, alias: string | null, fullName: string): Contact {
    return {
        owner_id: ME,
        contact_id: id,
        alias_name: alias,
        user: { id, full_name: fullName, username: 'peer', avatar_url: null },
    };
}

describe('DirectoryService', () => {
    let service: DirectoryService;
    let contactsApi: jasmine.SpyObj<ContactsApiService>;
    let chatApi: jasmine.SpyObj<ChatApiService>;

    beforeEach(() => {
        contactsApi = jasmine.createSpyObj<ContactsApiService>('ContactsApiService', ['getContacts']);
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['getUsersBatch', 'searchUsers']);

        const session = { user: () => ({ id: ME, full_name: 'Me', username: 'me', avatar: null }) as UserProfile };

        TestBed.configureTestingModule({
            providers: [
                DirectoryService,
                { provide: ContactsApiService, useValue: contactsApi },
                { provide: ChatApiService, useValue: chatApi },
                { provide: SessionService, useValue: session },
            ],
        });

        service = TestBed.inject(DirectoryService);
    });

    /** Names that cannot be resolved must read as unresolved, never as a guess. */
    it('falls back to a short id and marks it unresolved', () => {
        const identity = service.lookup(STRANGER);

        expect(identity.resolved).toBeFalse();
        expect(identity.name).toContain(STRANGER.slice(0, 8));
    });

    it('prefers a contact alias over the global name', async () => {
        contactsApi.getContacts.and.returnValue(of([contact(PEER, 'Work Alice', 'Alice Kowalski')]));

        await service.warm();

        expect(service.lookup(PEER).name).toBe('Work Alice');
    });

    it('uses the full name when no alias is set', async () => {
        contactsApi.getContacts.and.returnValue(of([contact(PEER, null, 'Alice Kowalski')]));

        await service.warm();

        expect(service.lookup(PEER).name).toBe('Alice Kowalski');
    });

    /**
     * The directory silently 404'd for an entire session because the request went to the wrong path,
     * and the only symptom was names degrading to ids. A failure must now be observable.
     */
    it('records a failure to load contacts instead of hiding it', async () => {
        contactsApi.getContacts.and.returnValue(throwError(() => new Error('nope')));

        await service.warm();

        expect(service.warmFailed()).toBeTrue();
        expect(service.lookup(PEER).resolved).toBeFalse();
    });

    it('resolves unknown ids in one batch and skips ones it already has', async () => {
        contactsApi.getContacts.and.returnValue(of([contact(PEER, 'Work Alice', 'Alice Kowalski')]));
        await service.warm();

        const found: UserSearchResult[] = [
            { id: STRANGER, full_name: 'Sam Okafor', username: 'sam', avatar_url: null },
        ];
        chatApi.getUsersBatch.and.returnValue(of(found));

        await service.resolveMissing([ME, PEER, STRANGER]);

        // Only the stranger is asked for: the alias for PEER would be clobbered by the global name.
        expect(chatApi.getUsersBatch).toHaveBeenCalledWith([STRANGER]);
        expect(service.lookup(STRANGER).name).toBe('Sam Okafor');
        expect(service.lookup(PEER).name).toBe('Work Alice');
    });

    describe('deleted users', () => {
        it('shows a deleted account neutrally, whatever the server sent', async () => {
            chatApi.getUsersBatch.and.returnValue(
                of([
                    {
                        id: STRANGER,
                        full_name: 'Deleted user',
                        username: 'deleted',
                        avatar_url: null,
                        is_deleted: true,
                    },
                ])
            );

            await service.resolveMissing([STRANGER]);

            const identity = service.lookup(STRANGER);
            expect(identity.name).toBe('Deleted user');
            expect(identity.deleted).toBeTrue();
            expect(identity.username).toBeNull();
            expect(identity.avatarUrl).toBeNull();
            expect(identity.resolved).withContext('a tombstone is a known fact, not an unresolved id').toBeTrue();
            expect(service.isDeleted(STRANGER)).toBeTrue();
        });

        it('does not flag an ordinary user as deleted', async () => {
            chatApi.getUsersBatch.and.returnValue(
                of([{ id: STRANGER, full_name: 'Sam Okafor', username: 'sam', avatar_url: null }])
            );

            await service.resolveMissing([STRANGER]);

            expect(service.isDeleted(STRANGER)).toBeFalse();
        });

        it('overrides a previously known live identity once the account is marked deleted', async () => {
            contactsApi.getContacts.and.returnValue(of([contact(PEER, 'Work Alice', 'Alice Kowalski')]));
            await service.warm();

            service.markDeleted(PEER);

            expect(service.lookup(PEER).name).toBe('Deleted user');
            expect(service.isDeleted(PEER)).toBeTrue();
        });

        it('remembers a private-chat peer as deleted instead of using the chat title', () => {
            service.rememberPrivateChatPeer(PEER, 'Deleted user', 'https://x/a.png', true);

            expect(service.isDeleted(PEER)).toBeTrue();
            expect(service.lookup(PEER).avatarUrl).toBeNull();
        });
    });

    it('makes no request when every id is already known', async () => {
        contactsApi.getContacts.and.returnValue(of([contact(PEER, null, 'Alice')]));
        await service.warm();

        await service.resolveMissing([ME, PEER]);

        expect(chatApi.getUsersBatch).not.toHaveBeenCalled();
    });
});
