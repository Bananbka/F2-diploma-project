import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { Chat, ChatParticipant } from '../models/chat.model';
import { ChatApiService } from './chat-api.service';
import { MembershipMismatchError, MembershipUnconfirmedError } from './crypto-errors';
import { DirectoryService } from './directory.service';
import { KeyStoreService, MemberExpectation } from './key-store.service';
import { MembershipGuardService } from './membership-guard.service';
import { SessionService } from './session.service';

const ME = 'a1111111-0000-4000-8000-000000000009';
const OTHER_ME = 'a2222222-0000-4000-8000-000000000008';
const PEER = 'e4a1c0de-0000-4000-8000-000000000001';
const OTHER_PEER = 'd0000000-0000-4000-8000-00000000000d';
const CHAT = 'c0000000-0000-4000-8000-00000000000c';

function member(user_id: string): ChatParticipant {
    return { user_id, role: 'member', joined_at: '2026-01-01T00:00:00Z' };
}

function chat(chat_type: Chat['chat_type'], ...ids: string[]): Chat {
    return {
        id: CHAT,
        chat_type,
        title: null,
        avatar_url: null,
        unread_count: 0,
        last_message: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
        participants: ids.map(member),
        muted_until: null,
        is_muted: false,
    };
}

describe('MembershipGuardService', () => {
    let service: MembershipGuardService;
    let keyStore: jasmine.SpyObj<KeyStoreService>;
    let chatApi: jasmine.SpyObj<ChatApiService>;
    const sink = jasmine.createSpy('sink');

    /** A "page reload": a fresh guard over the same storage. */
    function reload(): MembershipGuardService {
        return Injector.create({ parent: TestBed.inject(Injector), providers: [MembershipGuardService] }).get(
            MembershipGuardService
        );
    }

    beforeEach(() => {
        localStorage.clear();
        sink.calls.reset();
        keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', ['expectMembers']);
        chatApi = jasmine.createSpyObj<ChatApiService>('ChatApiService', ['getChat']);
        TestBed.configureTestingModule({
            providers: [
                { provide: KeyStoreService, useValue: keyStore },
                { provide: ChatApiService, useValue: chatApi },
                { provide: SessionService, useValue: { user: () => ({ id: ME }) } },
                {
                    provide: DirectoryService,
                    useValue: jasmine.createSpyObj('DirectoryService', ['resolveMissing']),
                },
            ],
        });
        service = TestBed.inject(MembershipGuardService);
    });

    afterEach(() => localStorage.clear());

    /** Round 2, item 2: a private chat's counterpart, pinned once and remembered across reloads. */
    describe('private chat pins', () => {
        it('pins once, persists, and never replaces the pin', () => {
            expect(service.pinnedPeer(ME, CHAT)).toBeNull();

            expect(service.pinPeer(ME, CHAT, PEER)).toBe(PEER);
            expect(service.pinPeer(ME, CHAT, OTHER_PEER))
                .withContext('the first pin wins')
                .toBe(PEER);

            expect(reload().pinnedPeer(ME, CHAT)).withContext('after a reload').toBe(PEER);
        });

        it('keeps pins per account of mine', () => {
            service.pinPeer(ME, CHAT, PEER);

            expect(service.pinnedPeer(OTHER_ME, CHAT)).toBeNull();
        });

        it('adopts a pin another tab wrote first', () => {
            localStorage.setItem('ns.private_peers', JSON.stringify({ [`${ME}:${CHAT}`]: OTHER_PEER }));

            expect(service.pinPeer(ME, CHAT, PEER)).toBe(OTHER_PEER);
        });

        it('holds a pin in memory when storage cannot be written', () => {
            spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');

            service.pinPeer(ME, CHAT, PEER);

            expect(service.pinnedPeer(ME, CHAT)).toBe(PEER);
        });

        /** Round 3, K: lookups read memory; other tabs' pins arrive by the storage event. */
        it('does not parse storage on a lookup, and adopts other tabs’ pins from the storage event', () => {
            const getItem = spyOn(Storage.prototype, 'getItem').and.callThrough();
            expect(service.pinnedPeer(ME, CHAT)).toBeNull();
            expect(getItem).not.toHaveBeenCalled();
            getItem.and.callThrough();

            localStorage.setItem('ns.private_peers', JSON.stringify({ [`${ME}:${CHAT}`]: OTHER_PEER }));
            expect(service.pinnedPeer(ME, CHAT)).withContext('no event yet').toBeNull();
            window.dispatchEvent(new StorageEvent('storage', { key: 'ns.private_peers' }));

            expect(service.pinnedPeer(ME, CHAT)).toBe(OTHER_PEER);
        });
    });

    describe('register', () => {
        it('pins and registers a well-formed private chat', () => {
            service.register(chat('private', ME, PEER), sink);

            expect(service.pinnedPeer(ME, CHAT)).toBe(PEER);
            expect(keyStore.expectMembers).toHaveBeenCalledOnceWith(CHAT, {
                kind: 'private',
                selfId: ME,
                peerId: PEER,
            });
        });

        it('refuses a mis-shaped private chat with no pin as unconfirmed, not as an alarm', () => {
            expect(() => service.register(chat('private', ME, PEER, OTHER_PEER), sink)).toThrowError(
                MembershipUnconfirmedError
            );
            expect(keyStore.expectMembers).not.toHaveBeenCalled();
        });

        it('registers a pinned private chat whose participants are not loaded', () => {
            service.pinPeer(ME, CHAT, PEER);

            service.register(chat('private'), sink);

            expect(keyStore.expectMembers).toHaveBeenCalledOnceWith(CHAT, {
                kind: 'private',
                selfId: ME,
                peerId: PEER,
            });
        });

        for (const type of ['group', 'channel'] as const) {
            it(`refuses a pinned private chat now reported as a ${type}`, () => {
                service.pinPeer(ME, CHAT, PEER);

                expect(() => service.register(chat(type, ME, PEER, OTHER_PEER), sink)).toThrowError(
                    MembershipMismatchError
                );
                expect(keyStore.expectMembers).not.toHaveBeenCalled();
            });
        }

        it('refuses a pinned private chat naming a different counterpart', () => {
            service.pinPeer(ME, CHAT, PEER);

            expect(() => service.register(chat('private', ME, OTHER_PEER), sink)).toThrowError(MembershipMismatchError);
        });

        it('hands a group publish’s participant list to the sink before returning it', async () => {
            service.register(chat('group', ME), sink);
            const expectation = keyStore.expectMembers.calls.mostRecent().args[1] as MemberExpectation;
            chatApi.getChat.and.returnValue(of(chat('group', ME, PEER, OTHER_PEER)));

            const ids = expectation.kind === 'group' ? await expectation.resolve() : [];

            expect(ids).toEqual([ME, PEER, OTHER_PEER]);
            expect(sink).toHaveBeenCalledOnceWith(CHAT, [member(ME), member(PEER), member(OTHER_PEER)]);
        });
    });

    /**
     * S2: a group is never pinned (its members change), so a server could relabel one as a channel
     * and turn the next message into a readable post. Having been seen as encrypted is what refuses it.
     */
    describe('chats seen as encrypted', () => {
        it('refuses a group it registered once, now reported as a channel', () => {
            service.register(chat('group', ME, PEER), sink);

            expect(() => service.register(chat('channel', ME, PEER), sink)).toThrowMatching(
                (error) => error instanceof MembershipMismatchError && /encrypted group.*channel/.test(error.message)
            );
        });

        it('refuses a chat noted as encrypted when its keys loaded, now reported as a channel', () => {
            service.noteEncrypted(CHAT, 'group');

            expect(service.encryptedTypeOf(CHAT)).toBe('group');
            expect(() => service.register(chat('channel'), sink)).toThrowError(MembershipMismatchError);
        });

        it('counts a pinned private chat as encrypted, with the private-chat wording', () => {
            service.pinPeer(ME, CHAT, PEER);

            expect(service.encryptedTypeOf(CHAT)).toBe('private');
            expect(() => service.register(chat('channel'), sink)).toThrowMatching(
                (error) => error instanceof MembershipMismatchError && /private chat.*channel/.test(error.message)
            );
        });

        it('lets a chat only ever seen as a channel register as one', () => {
            expect(service.encryptedTypeOf(CHAT)).toBeNull();
            expect(() => service.register(chat('channel', ME), sink)).not.toThrow();
            expect(keyStore.expectMembers).not.toHaveBeenCalled();
        });

        it('never replaces the first recorded type', () => {
            service.noteEncrypted(CHAT, 'private');
            service.noteEncrypted(CHAT, 'group');

            expect(service.encryptedTypeOf(CHAT)).toBe('private');
        });

        it('is kept per account of ours', () => {
            service.noteEncrypted(CHAT, 'group');
            const stored = JSON.parse(localStorage.getItem('ns.encrypted_chats')!) as Record<string, string>;

            expect(stored).toEqual({ [`${ME}:${CHAT}`]: 'group' });
            expect(Object.keys(stored)).not.toContain(`${OTHER_ME}:${CHAT}`);
        });

        it('survives a reload', () => {
            service.noteEncrypted(CHAT, 'group');

            expect(reload().encryptedTypeOf(CHAT)).toBe('group');
        });

        it("honours another tab's record before its storage event arrives", () => {
            reload().noteEncrypted(CHAT, 'group');

            expect(service.encryptedTypeOf(CHAT)).toBe('group');
            expect(() => service.register(chat('channel'), sink)).toThrowError(MembershipMismatchError);
        });

        it("adopts another tab's record through the storage event, and keeps it if storage is cleared", () => {
            reload().noteEncrypted(CHAT, 'group');
            window.dispatchEvent(
                new StorageEvent('storage', {
                    key: 'ns.encrypted_chats',
                    newValue: localStorage.getItem('ns.encrypted_chats'),
                })
            );
            localStorage.clear();
            window.dispatchEvent(new StorageEvent('storage', { key: null }));

            expect(service.encryptedTypeOf(CHAT)).toBe('group');
        });

        it('keeps its records when another tab clears storage', () => {
            service.noteEncrypted(CHAT, 'group');
            localStorage.clear();
            window.dispatchEvent(new StorageEvent('storage', { key: null }));

            expect(service.encryptedTypeOf(CHAT)).toBe('group');
        });

        it('drops tampered stored values instead of trusting them', () => {
            localStorage.setItem('ns.encrypted_chats', JSON.stringify({ [`${ME}:${CHAT}`]: 'channel' }));

            expect(reload().encryptedTypeOf(CHAT)).toBeNull();
        });
    });
});
