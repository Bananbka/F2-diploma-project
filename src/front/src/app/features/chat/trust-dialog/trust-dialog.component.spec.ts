import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { Chat, ChatParticipant } from '../../../core/models/chat.model';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStoreService } from '../../../core/services/chat-store.service';
import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { InfoDialogService } from '../info-dialog/info-dialog.service';
import { classifySafetyError } from '../safety-number/safety-number.component';
import { TrustDialogComponent } from './trust-dialog.component';
import { TrustDialogService } from './trust-dialog.service';

const ME = 'me';
const CHAT_ID = 'chat-1';

const participants = (...ids: string[]): ChatParticipant[] =>
    ids.map((user_id) => ({ user_id, role: 'member' as const, joined_at: '2024-01-01T00:00:00Z' }));

describe('TrustDialogService routing', () => {
    let service: TrustDialogService;
    let info: InfoDialogService;

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideRouter([])] });
        service = TestBed.inject(TrustDialogService);
        info = TestBed.inject(InfoDialogService);
    });

    it('a private chat opens the peer safety number in the info dialog', () => {
        service.openSecurity({ id: 'c', chat_type: 'private', participants: participants(ME, 'peer') }, ME);
        expect(info.chatId()).toBe('c');
        expect(service.chatId()).toBeNull();
    });

    it('a group opens the encryption dialog, never one member', () => {
        service.openSecurity({ id: 'g', chat_type: 'group', participants: participants(ME, 'a', 'b') }, ME);
        expect(service.chatId()).toBe('g');
        expect(info.chatId()).toBeNull();
    });

    it('a channel opens the encryption dialog too', () => {
        service.openSecurity({ id: 'ch', chat_type: 'channel', participants: participants(ME, 'a') }, ME);
        expect(service.chatId()).toBe('ch');
        expect(info.chatId()).toBeNull();
    });
});

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

describe('TrustDialogComponent', () => {
    let fixture: ComponentFixture<TrustDialogComponent>;
    let keyStore: { computeSafetyNumber: jasmine.Spy };
    let chatApi: { getChat: jasmine.Spy };
    let closed: number;
    let verificationError: ReturnType<typeof signal<string | null>>;

    async function open(chat: Partial<Chat>) {
        chatApi.getChat.and.returnValue(of({ id: CHAT_ID, chat_type: 'group', participants: [], ...chat }));
        fixture = TestBed.createComponent(TrustDialogComponent);
        fixture.componentRef.setInput('chatId', CHAT_ID);
        closed = 0;
        fixture.componentInstance.closed.subscribe(() => closed++);
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
                return `number-${id}`;
            }),
        };
        chatApi = { getChat: jasmine.createSpy('getChat') };
        TestBed.configureTestingModule({
            providers: [
                provideRouter([]),
                { provide: ChatApiService, useValue: chatApi },
                {
                    provide: CryptoApiService,
                    useValue: {
                        getRoster: () => of({ chat_id: CHAT_ID, current_epoch: 4, member_set_hash: 'h', members: [] }),
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
                { provide: TrustStoreService, useValue: { stateFor: () => ({ kind: 'unverified' }) } },
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

    it('opens a member safety number inline and Escape steps back before closing', async () => {
        const root = await open({ participants: participants(ME, 'a') });
        root.querySelector<HTMLButtonElement>('.row .link')!.click();
        fixture.detectChanges();
        expect(root.querySelector('app-safety-number')).not.toBeNull();
        expect(root.querySelector('.icon[aria-label="Back to members"]')).not.toBeNull();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        fixture.detectChanges();
        expect(root.querySelector('app-safety-number')).toBeNull();
        expect(closed).toBe(0);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(closed).toBe(1);
    });

    it('surfaces a failed member-set verification', async () => {
        verificationError.set('roster mismatch');
        const root = await open({ participants: participants(ME, 'a') });
        expect(root.textContent).toContain('Member set could not be verified');
        expect(root.textContent).toContain('roster mismatch');
    });

    it('a channel shows the signed, not encrypted explanation and no member list', async () => {
        const root = await open({ chat_type: 'channel', participants: participants(ME, 'a') });
        expect(root.textContent).toContain('Signed, not encrypted');
        expect(root.querySelector('.members')).toBeNull();
    });
});
