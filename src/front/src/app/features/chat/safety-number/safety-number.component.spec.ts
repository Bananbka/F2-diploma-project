import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DirectoryService } from '../../../core/services/directory.service';
import { KeyStoreService } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { SafetyNumberComponent } from './safety-number.component';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const ME = 'a1111111-0000-4000-8000-000000000009';
const PEER = 'bbbbbbbb-0000-4000-8000-000000000002';
const NUMBER_A = '04672 91834 52017 73649 18293 64751 39082 57164 82031 46918 73052 19374';
const NUMBER_B = '11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12345 67890';

describe('SafetyNumberComponent', () => {
    let fixture: ComponentFixture<SafetyNumberComponent>;
    let trust: TrustStoreService;
    let keyStore: jasmine.SpyObj<KeyStoreService>;

    async function render(safetyNumber: string): Promise<HTMLElement> {
        keyStore.computeSafetyNumber.and.resolveTo(safetyNumber);

        fixture.componentRef.setInput('chatId', CHAT);
        fixture.componentRef.setInput('userId', PEER);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        localStorage.clear();

        // The number is derived in KeyStoreService, not fetched. A fingerprint the server hands
        // you cannot detect a key the server substituted, which is the one thing it exists for.
        keyStore = jasmine.createSpyObj<KeyStoreService>('KeyStoreService', ['computeSafetyNumber']);
        keyStore.computeSafetyNumber.and.resolveTo(NUMBER_A);

        const directory = jasmine.createSpyObj<DirectoryService>('DirectoryService', ['lookup']);
        directory.lookup.and.returnValue({
            userId: PEER,
            name: 'Alice',
            username: 'alice',
            avatarUrl: null,
            resolved: true,
        });

        await TestBed.configureTestingModule({
            imports: [SafetyNumberComponent],
            providers: [
                { provide: KeyStoreService, useValue: keyStore },
                { provide: DirectoryService, useValue: directory },
                { provide: SessionService, useValue: { user: signal({ id: ME }) } },
            ],
        }).compileComponents();

        trust = TestBed.inject(TrustStoreService);
        fixture = TestBed.createComponent(SafetyNumberComponent);
    });

    afterEach(() => localStorage.clear());

    it('explains a contact with no published key instead of a generic error', async () => {
        keyStore.computeSafetyNumber.and.rejectWith(
            new Error('This contact has not published a verifiable identity key.')
        );
        fixture.componentRef.setInput('chatId', CHAT);
        fixture.componentRef.setInput('userId', PEER);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        const text = (fixture.nativeElement as HTMLElement).querySelector('.error')?.textContent ?? '';
        expect(text).toContain('has not published encryption keys yet');
        expect(text).not.toContain('Could not compute');
        expect(fixture.componentInstance.failure()).toBe('peer-no-keys');
    });

    it('explains the user own missing key separately', async () => {
        keyStore.computeSafetyNumber.and.rejectWith(new Error('You have not published an identity key.'));
        fixture.componentRef.setInput('chatId', CHAT);
        fixture.componentRef.setInput('userId', PEER);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect((fixture.nativeElement as HTMLElement).querySelector('.error')?.textContent).toContain(
            'You have not published'
        );
    });

    it('splits the fingerprint into twelve groups of five', async () => {
        await render(NUMBER_A);

        expect(fixture.componentInstance.groups().length).toBe(12);
        expect(fixture.componentInstance.groups().every((group) => group.length === 5)).toBeTrue();
    });

    it('starts unverified and asks the user to compare out of band', async () => {
        const host = await render(NUMBER_A);

        expect(fixture.componentInstance.state()?.kind).toBe('unverified');
        expect(host.textContent).toContain('in person');
    });

    /**
     * The most important assertion here. A changed number is what a server substituting a public key
     * produces, so it must be stated loudly rather than folded back into "not yet verified" — and it
     * must not re-trust the new key on its own.
     */
    it("raises a loud alarm when a verified peer's number changes", async () => {
        trust.markVerified(ME, PEER, NUMBER_B);

        const host = await render(NUMBER_A);

        expect(fixture.componentInstance.state()?.kind).toBe('changed');
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
        expect(host.textContent).toContain('has changed');
        // Accepting is an explicit act, never automatic.
        expect(host.textContent).toContain('I compared the new number');
    });

    it('confirms a peer whose number is unchanged since verification', async () => {
        trust.markVerified(ME, PEER, NUMBER_A);

        const host = await render(NUMBER_A);

        expect(fixture.componentInstance.state()?.kind).toBe('verified');
        expect(host.textContent).toContain('Verified');
    });

    it('does not alarm for the same peer when I am signed in as a different account of mine', async () => {
        // Verified under another of my accounts; this account has never compared with this peer.
        trust.markVerified('a2222222-0000-4000-8000-000000000008', PEER, NUMBER_B);

        const host = await render(NUMBER_A);

        expect(fixture.componentInstance.state()?.kind).toBe('unverified');
        expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it('names both keys as possible causes in the alarm', async () => {
        trust.markVerified(ME, PEER, NUMBER_B);

        const host = await render(NUMBER_A);

        expect(host.querySelector('.alarm-note')?.textContent).toContain('your own keys change');
    });
});
