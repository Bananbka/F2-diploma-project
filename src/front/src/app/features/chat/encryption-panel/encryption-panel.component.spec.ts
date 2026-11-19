import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, Subject, throwError } from 'rxjs';

import { computeMemberSetHash } from '../../../core/crypto/grants';
import { generateIdentity } from '../../../core/crypto/identity';
import { b64uEncode } from '../../../core/crypto/primitives';
import { Chat, ChatParticipant } from '../../../core/models/chat.model';
import { ChatRoster, RosterEntry } from '../../../core/models/crypto.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { KeyChangeStateService, Refusal } from '../../../core/services/key-change-state.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { classifySafetyError } from '../safety-number/safety-number.component';
import { EncryptionPanelComponent } from './encryption-panel.component';

const ME = 'me';
const CHAT_ID = 'chat-1';

const participants = (...ids: string[]): ChatParticipant[] =>
    ids.map((user_id) => ({ user_id, role: 'member' as const, joined_at: '2024-01-01T00:00:00Z' }));

describe('classifySafetyError', () => {
    it('tells a contact without keys from the user without keys from a real failure', () => {
        expect(classifySafetyError(new Error('This contact has not published a verifiable identity key.'))).toBe(
            'peer-no-keys'
        );
        expect(classifySafetyError(new Error('You have not published an identity key.'))).toBe('self-no-keys');
        expect(classifySafetyError(new Error('network'))).toBe('failed');
        expect(classifySafetyError('x')).toBe('failed');
    });
});

describe('EncryptionPanelComponent', () => {
    let fixture: ComponentFixture<EncryptionPanelComponent>;
    let keyStore: { computeSafetyNumber: jasmine.Spy };
    let chatApi: { getChat: jasmine.Spy };
    let verificationError: ReturnType<typeof signal<string | null>>;
    let getRoster: jasmine.Spy<() => Observable<ChatRoster>>;
    let refusals: ReturnType<typeof signal<Record<string, Refusal>>>;
    let blocking: ReturnType<typeof signal<Record<string, string>>>;
    let trustState: ReturnType<typeof signal<'unverified' | 'verified'>>;

    /** An empty roster whose commitment really is the hash of its members, so the check passes. */
    const matchingRoster = (): ChatRoster => ({
        chat_id: CHAT_ID,
        current_epoch: 4,
        member_set_hash: computeMemberSetHash([]),
        members: [],
    });

    async function open(chat: Partial<Chat>) {
        chatApi.getChat.and.returnValue(of({ id: CHAT_ID, chat_type: 'group', participants: [], ...chat }));
        fixture = TestBed.createComponent(EncryptionPanelComponent);
        fixture.componentRef.setInput('chatId', CHAT_ID);
        fixture.detectChanges();
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve));
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(() => {
        verificationError = signal<string | null>(null);
        keyStore = {
            computeSafetyNumber: jasmine.createSpy().and.callFake(async (id: string) => {
                if (id === 'nokey') {
                    throw new Error('This contact has not published a verifiable identity key.');
                }
                return {
                    number: `number-${id}`,
                    ownDevicesUnknown: false,
                    ownDevicesUnchecked: false,
                    ownDevicesAdded: false,
                };
            }),
        };
        chatApi = { getChat: jasmine.createSpy('getChat') };
        getRoster = jasmine.createSpy('getRoster').and.callFake(() => of(matchingRoster()));
        refusals = signal<Record<string, Refusal>>({});
        blocking = signal<Record<string, string>>({});
        trustState = signal<'unverified' | 'verified'>('unverified');
        TestBed.configureTestingModule({
            providers: [
                provideRouter([]),
                { provide: ChatApiService, useValue: chatApi },
                { provide: CryptoApiService, useValue: { getRoster } },
                {
                    provide: KeyChangeStateService,
                    useValue: {
                        refusalFor: (chatId: string, _me: string, peer: string) =>
                            chatId === CHAT_ID ? (refusals()[peer] ?? null) : null,
                        blockingNumber: (_me: string, peer: string, chatId?: string) =>
                            chatId === CHAT_ID ? (blocking()[peer] ?? null) : null,
                    },
                },
                { provide: KeyStoreService, useValue: keyStore },
                { provide: SessionService, useValue: { user: () => ({ id: ME }) } },
                {
                    provide: DirectoryService,
                    useValue: { lookup: (id: string) => ({ userId: id, name: `Name ${id}`, avatarUrl: null }) },
                },
                {
                    provide: ChatStoreService,
                    useValue: {
                        memberVerificationError: verificationError,
                        chatKeys: signal({
                            current_epoch: 4,
                            epochs: [{ epoch: 4, created_at: '2024-02-02T00:00:00Z' }],
                        }),
                    },
                },
                { provide: TrustStoreService, useValue: { stateFor: () => ({ kind: trustState() }) } },
            ],
        });
    });

    afterEach(() => fixture.destroy());

    it('shows the group status: epoch, rotation, and every member with a key state', async () => {
        const root = await open({ participants: participants(ME, 'a', 'nokey') });
        expect(root.textContent).toContain('End-to-end encrypted');
        expect(root.textContent).toContain('Key epoch');
        expect(root.textContent).toContain('4');
        expect(root.textContent).toContain('Last key rotation');
        const rows = Array.from(root.querySelectorAll('.row'));
        expect(rows.length).toBe(2);
        expect(rows[0].textContent).toContain('Name a');
        expect(rows[0].querySelector('.badge')?.textContent).toContain('Not verified');
        expect(rows[1].querySelector('.badge')?.textContent).toContain('No published key yet');
    });

    it('a member with no key cannot be opened and says why', async () => {
        const root = await open({ participants: participants(ME, 'nokey') });
        const button = root.querySelector<HTMLButtonElement>('.row .link')!;
        expect(button.disabled).toBeTrue();
        expect(
            Array.from(root.querySelectorAll('.sr-only'))
                .map((e) => e.textContent)
                .join(' ')
        ).toContain('has not published encryption keys yet');
    });

    it('asks the host to open a member safety number rather than opening one itself', async () => {
        const root = await open({ participants: participants(ME, 'a') });
        const requested: string[] = [];
        fixture.componentInstance.safetyRequested.subscribe((id) => requested.push(id));
        root.querySelector<HTMLButtonElement>('.row .link')!.click();
        expect(requested).toEqual(['a']);
        expect(root.querySelector('.dialog, [role="dialog"]')).toBeNull();
    });

    it('surfaces a failed member-set verification', async () => {
        verificationError.set('roster mismatch');
        const root = await open({ participants: participants(ME, 'a') });
        expect(root.textContent).toContain('Member set could not be verified');
        expect(root.textContent).toContain('roster mismatch');
    });

    /** S1: the header's claim comes from this panel's own check of the roster it fetched. */
    describe('header claim', () => {
        it('claims a match only when the fetched roster matches its commitment', async () => {
            const root = await open({ participants: participants(ME, 'a') });
            expect(root.textContent).toContain('The member list matches the commitment for the current keys.');
            expect(root.querySelector('.status.is-alert')).toBeNull();
        });

        it('says the member list was not checked when the roster could not be fetched', async () => {
            getRoster.and.returnValue(throwError(() => new Error('network')));
            const root = await open({ participants: participants(ME, 'a') });
            expect(root.textContent).toContain('has not been checked');
            expect(root.textContent).not.toContain('matches the commitment');
        });

        it('raises the alarm when the fetched roster does not match its commitment', async () => {
            getRoster.and.returnValue(of({ ...matchingRoster(), member_set_hash: 'forged' }));
            const root = await open({ participants: participants(ME, 'a') });
            expect(root.textContent).toContain('Member set does not match');
            expect(root.textContent).not.toContain('matches the commitment for the current keys.');
            expect(root.querySelector('.status.is-alert')).not.toBeNull();
        });
    });

    /**
     * L7: the members listed are the chat's participants, so "matches" also needs the roster to name
     * nobody outside them. A roster can agree with its own commitment and still carry a device for
     * someone the list does not show.
     */
    describe('roster against the member list shown', () => {
        const uuid = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`;

        /** A genuinely bound roster entry, so the commitment check itself passes. */
        function entry(userId: string, deviceId: string, active = true): RosterEntry {
            const bundle = generateIdentity(userId, deviceId, false);
            return {
                user_id: userId,
                device_id: deviceId,
                identity_key_id: deviceId,
                identity_public_key: b64uEncode(bundle.identityPublic),
                signing_public_key: b64uEncode(bundle.signingPublic),
                identity_key_signature: b64uEncode(bundle.identityKeySignature),
                signed_prekey_public: null,
                signed_prekey_signature: null,
                ...(active ? {} : { is_active: false }),
            };
        }

        function rosterOf(...members: RosterEntry[]): ChatRoster {
            return { chat_id: CHAT_ID, current_epoch: 4, member_set_hash: computeMemberSetHash(members), members };
        }

        const [MEMBER_A, MEMBER_B, OUTSIDER] = [uuid(1), uuid(2), uuid(3)];

        it('claims a match when every roster entry belongs to a listed member', async () => {
            getRoster.and.returnValue(of(rosterOf(entry(MEMBER_A, uuid(4)), entry(MEMBER_B, uuid(5)))));
            const root = await open({ participants: participants(ME, MEMBER_A, MEMBER_B) });
            expect(root.textContent).toContain('The member list matches the commitment for the current keys.');
        });

        it('raises the alarm for a self-consistent roster with a device of someone not listed', async () => {
            getRoster.and.returnValue(of(rosterOf(entry(MEMBER_A, uuid(4)), entry(OUTSIDER, uuid(6)))));
            const root = await open({ participants: participants(ME, MEMBER_A, MEMBER_B) });
            expect(root.textContent).toContain('Member set does not match');
            expect(root.textContent).not.toContain('matches the commitment for the current keys.');
            expect(root.querySelector('.status.is-alert')).not.toBeNull();
        });

        it('ignores an inactive entry of someone not listed, as the send path does', async () => {
            getRoster.and.returnValue(of(rosterOf(entry(MEMBER_A, uuid(4)), entry(OUTSIDER, uuid(6), false))));
            const root = await open({ participants: participants(ME, MEMBER_A) });
            expect(root.textContent).toContain('The member list matches the commitment for the current keys.');
        });
    });

    /** L7: one instance serves every chat, so a slow answer must not land under the next chat. */
    describe('switching chats while a load is in flight', () => {
        const OTHER_CHAT = 'chat-2';

        it("does not show the previous chat's roster, members or error under the new chat", async () => {
            const slowRoster = new Subject<ChatRoster>();
            getRoster.and.callFake(((chatId: string) =>
                chatId === CHAT_ID ? slowRoster : throwError(() => new Error('network'))) as never);
            chatApi.getChat.and.callFake((chatId: string) =>
                of({
                    id: chatId,
                    chat_type: 'group',
                    participants: participants(ME, chatId === CHAT_ID ? 'from-first' : 'from-second'),
                })
            );
            fixture = TestBed.createComponent(EncryptionPanelComponent);
            fixture.componentRef.setInput('chatId', CHAT_ID);
            fixture.detectChanges();
            await fixture.whenStable();

            fixture.componentRef.setInput('chatId', OTHER_CHAT);
            fixture.detectChanges();
            await fixture.whenStable();
            await new Promise((resolve) => setTimeout(resolve));

            // The first chat's roster arrives only now, and a forged one at that.
            slowRoster.next({ chat_id: CHAT_ID, current_epoch: 9, member_set_hash: 'forged', members: [] });
            slowRoster.complete();
            await new Promise((resolve) => setTimeout(resolve));
            fixture.detectChanges();

            const component = fixture.componentInstance;
            const root = fixture.nativeElement as HTMLElement;
            expect(component.chat()?.id).toBe(OTHER_CHAT);
            expect(component.roster()).withContext('the second chat has no roster').toBeNull();
            expect(component.memberSetCheck()).toBeNull();
            expect(root.textContent).toContain('has not been checked');
            expect(root.textContent).not.toContain('Member set does not match');
            expect(root.textContent).toContain('Name from-second');
            expect(root.textContent).not.toContain('Name from-first');
        });

        it('clears the previous roster as soon as another chat starts loading', async () => {
            await open({ participants: participants(ME, 'a') });
            expect(fixture.componentInstance.roster()).not.toBeNull();

            chatApi.getChat.and.returnValue(new Subject());
            fixture.componentRef.setInput('chatId', OTHER_CHAT);
            fixture.detectChanges();

            expect(fixture.componentInstance.roster()).toBeNull();
            expect(fixture.componentInstance.chat()).toBeNull();
        });
    });

    /**
     * S1: a member this chat is refused on reads "Key changed" whatever the lookup says. In the
     * equivocation case the batch lookup carries the old keys and derives the verified number.
     */
    describe("per-member status against this chat's refusals", () => {
        beforeEach(() => trustState.set('verified'));

        it('shows a refused member as changed even when the lookup reads verified', async () => {
            refusals.set({ a: { current: 'new', previous: 'old', ownDevicesChanged: false, recordedAgainst: null } });
            const root = await open({ participants: participants(ME, 'a', 'b') });
            const rows = Array.from(root.querySelectorAll('.row'));
            expect(rows[0].querySelector('.badge')?.textContent).toContain('Key changed');
            expect(rows[1].querySelector('.badge')?.textContent).toContain('Verified');
        });

        it('shows a member the send path is blocked on as changed', async () => {
            blocking.set({ b: 'new' });
            const root = await open({ participants: participants(ME, 'a', 'b') });
            const rows = Array.from(root.querySelectorAll('.row'));
            expect(rows[0].querySelector('.badge')?.textContent).toContain('Verified');
            expect(rows[1].querySelector('.badge')?.textContent).toContain('Key changed');
        });
    });

    it('a channel shows the signed, not encrypted explanation and no member list', async () => {
        const root = await open({ chat_type: 'channel', participants: participants(ME, 'a') });
        expect(root.textContent).toContain('Signed, not encrypted');
        expect(root.querySelector('.members')).toBeNull();
    });
});
