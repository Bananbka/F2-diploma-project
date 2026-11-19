import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DirectoryService } from '../../../core/services/directory.service';
import { KeyChangeStateService } from '../../../core/services/key-change-state.service';
import { KeyStoreService, SafetyNumberResult } from '../../../core/services/key-store.service';
import { SessionService } from '../../../core/services/session.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { SettingsService } from '../../settings/settings.service';
import { SafetyNumberComponent } from './safety-number.component';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const ME = 'a1111111-0000-4000-8000-000000000009';
const PEER = 'bbbbbbbb-0000-4000-8000-000000000002';
const NUMBER_A = '04672 91834 52017 73649 18293 64751 39082 57164 82031 46918 73052 19374';
const NUMBER_B = '11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12345 67890';

/** `KeyStoreService.computeSafetyNumber`'s result for a number, with nothing found about our own side. */
function result(number: string, extra: Partial<SafetyNumberResult> = {}): SafetyNumberResult {
    return { number, ownDevicesUnknown: false, ownDevicesAdded: false, ...extra };
}

describe('SafetyNumberComponent', () => {
    let fixture: ComponentFixture<SafetyNumberComponent>;
    let trust: TrustStoreService;
    let keyStore: jasmine.SpyObj<KeyStoreService>;

    async function render(safetyNumber: string): Promise<HTMLElement> {
        keyStore.computeSafetyNumber.and.resolveTo(result(safetyNumber));

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
        keyStore.computeSafetyNumber.and.resolveTo(result(NUMBER_A));

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

    /**
     * G5: an equivocating server can answer this screen's key lookup with the old keys while the
     * roster the send path checks carries new ones. The screen must show the number sending is
     * blocked on — accepting anything else could never lift the block.
     */
    describe('while sending is blocked on a changed number', () => {
        const NUMBER_C = '22222 33333 44444 55555 66666 77777 88888 99999 00000 11111 23456 78901';

        it('shows the blocking number, not the lookup, and says the two disagree', async () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_C, 'roster');

            // The lookup answers with the old, still-verified keys.
            const host = await render(NUMBER_A);

            expect(fixture.componentInstance.safetyNumber()).toBe(NUMBER_C);
            expect(fixture.componentInstance.state()?.kind).toBe('changed');
            expect(host.querySelector('.full-value')?.textContent).toContain(NUMBER_C);
            expect(host.textContent).toContain('not presenting the same keys everywhere');
            // The banner must not read "Verified" off the lookup.
            expect(host.textContent).not.toContain('It has not changed since');
        });

        it('accepts the blocking number, which is what lifts the block', async () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_C, 'roster');
            await render(NUMBER_C);

            fixture.componentInstance.acceptChange();

            expect(trust.stateFor(ME, PEER, NUMBER_C).kind).toBe('verified');
            expect(TestBed.inject(KeyChangeStateService).blockingNumber(ME, PEER)).toBeNull();
        });

        it('does not claim a disagreement when the lookup agrees with the blocking number', async () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_C, 'roster');

            const host = await render(NUMBER_C);

            expect(fixture.componentInstance.lookupDisagrees()).toBeFalse();
            expect(host.textContent).not.toContain('not presenting the same keys everywhere');
        });

        it('still shows the blocking number when the lookup itself fails', async () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_C, 'roster');
            keyStore.computeSafetyNumber.and.rejectWith(new Error('network'));
            fixture.componentRef.setInput('chatId', CHAT);
            fixture.componentRef.setInput('userId', PEER);
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();

            expect(fixture.componentInstance.error()).toBeNull();
            expect(fixture.componentInstance.safetyNumber()).toBe(NUMBER_C);
        });
    });

    /** Round 2, items 4-7. */
    describe('round 2', () => {
        const NUMBER_C = '22222 33333 44444 55555 66666 77777 88888 99999 00000 11111 23456 78901';

        it("shows this chat's refused number even after another chat's roster observed the verified one", async () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_C, 'roster');
            TestBed.inject(KeyChangeStateService).recordRefusal(CHAT, ME, PEER, NUMBER_C, NUMBER_A);
            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_A, 'roster');

            const host = await render(NUMBER_A);

            expect(fixture.componentInstance.safetyNumber()).toBe(NUMBER_C);
            expect(fixture.componentInstance.state()?.kind).toBe('changed');
            expect(host.textContent).not.toContain('It has not changed since');
        });

        it('snapshots the digits, disables accepting when the number changes underneath, and reloads on request', async () => {
            const host = await render(NUMBER_A);
            expect(fixture.componentInstance.safetyNumber()).toBe(NUMBER_A);

            // A refusal arrives while the screen is open.
            trust.markVerified(ME, PEER, NUMBER_B);
            TestBed.inject(KeyChangeStateService).observe(ME, PEER, NUMBER_C, 'roster');
            TestBed.inject(KeyChangeStateService).recordRefusal(CHAT, ME, PEER, NUMBER_C, NUMBER_B);
            fixture.detectChanges();

            expect(fixture.componentInstance.safetyNumber()).withContext('digits never swap').toBe(NUMBER_A);
            expect(fixture.componentInstance.numberChanged()).toBeTrue();
            expect(host.textContent).toContain('The number changed while you were viewing');
            const accept = host.querySelector<HTMLButtonElement>('button.submit');
            expect(accept?.disabled).toBeTrue();

            // Clicking through anyway records nothing.
            fixture.componentInstance.markVerified();
            expect(trust.stateFor(ME, PEER, NUMBER_A).kind).toBe('changed');

            await fixture.componentInstance.reloadComparison();
            fixture.detectChanges();
            expect(fixture.componentInstance.safetyNumber()).toBe(NUMBER_C);
            expect(fixture.componentInstance.numberChanged()).toBeFalse();
            expect(host.querySelector<HTMLButtonElement>('button.submit')?.disabled).toBeFalse();
        });

        it('warns when our own side covers a device no device list of ours contains', async () => {
            keyStore.computeSafetyNumber.and.resolveTo(result(NUMBER_A, { ownDevicesUnknown: true }));
            fixture.componentRef.setInput('chatId', CHAT);
            fixture.componentRef.setInput('userId', PEER);
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            const host = fixture.nativeElement as HTMLElement;

            expect(host.textContent).toContain('Your own device list differs');
        });

        it('says when a verification could not be saved', async () => {
            const host = await render(NUMBER_A);
            spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');

            fixture.componentInstance.markVerified();
            fixture.detectChanges();

            expect(fixture.componentInstance.saveFailed()).toBeTrue();
            expect(host.textContent).toContain('could not be saved');
            // Still verified for this tab.
            expect(fixture.componentInstance.state()?.kind).toBe('verified');
        });
    });

    /** Round 3. */
    describe('round 3', () => {
        const NUMBER_C = '22222 33333 44444 55555 66666 77777 88888 99999 00000 11111 23456 78901';

        /** L: while this chat is refused, the screen is the alarm, whatever digits are shown. */
        it('reads as changed while this chat holds a refusal, even when the digits equal the record', async () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            const host = await render(NUMBER_A);
            expect(fixture.componentInstance.state()?.kind).toBe('verified');

            // The refusal lands while the old (still-on-record) digits are on screen.
            TestBed.inject(KeyChangeStateService).recordRefusal(CHAT, ME, PEER, NUMBER_C, NUMBER_A);
            fixture.detectChanges();

            expect(fixture.componentInstance.safetyNumber()).toBe(NUMBER_A);
            expect(fixture.componentInstance.state()?.kind).toBe('changed');
            expect(host.textContent).not.toContain('Clear verification');
            expect(host.textContent).toContain('I compared the new number');
        });

        /** B: "Clear verification" is refused while a refusal holds, and the screen says why. */
        it('says why clearing is refused while a send is refused on a changed number', async () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            const keyChange = TestBed.inject(KeyChangeStateService);
            const host = await render(NUMBER_A);
            keyChange.recordRefusal('another-chat', ME, PEER, NUMBER_C, NUMBER_A);

            fixture.componentInstance.reset();
            fixture.detectChanges();

            expect(fixture.componentInstance.forgetRefused()).toBeTrue();
            expect(host.textContent).toContain('cannot be cleared');
            expect(trust.stateFor(ME, PEER, NUMBER_A).kind).toBe('verified');
        });

        /** H: a slow lookup for a previous person must not land on the current one. */
        it('drops a lookup that finishes after the screen moved on to someone else', async () => {
            let releaseFirst!: (value: SafetyNumberResult) => void;
            keyStore.computeSafetyNumber.and.returnValues(
                new Promise<SafetyNumberResult>((resolve) => (releaseFirst = resolve)),
                Promise.resolve(result(NUMBER_B))
            );
            fixture.componentRef.setInput('chatId', CHAT);
            fixture.componentRef.setInput('userId', PEER);
            fixture.detectChanges();
            fixture.componentRef.setInput('userId', 'someone-else');
            fixture.detectChanges();
            await fixture.whenStable();

            releaseFirst(result(NUMBER_A));
            await fixture.whenStable();

            expect(fixture.componentInstance.safetyNumber()).toBe(NUMBER_B);
            expect(fixture.componentInstance.loading()).toBeFalse();
        });

        /** N: a device our own list confirms is a notice pointing at Settings, not an alarm. */
        it('shows a notice, linking to the device list, for a device added since unlock', async () => {
            keyStore.computeSafetyNumber.and.resolveTo(result(NUMBER_A, { ownDevicesAdded: true }));
            fixture.componentRef.setInput('chatId', CHAT);
            fixture.componentRef.setInput('userId', PEER);
            fixture.detectChanges();
            await fixture.whenStable();
            fixture.detectChanges();
            const host = fixture.nativeElement as HTMLElement;
            const settings = TestBed.inject(SettingsService);
            spyOn(settings, 'open');

            expect(host.textContent).toContain('added to your account since you unlocked');
            expect(host.textContent).not.toContain('Your own device list differs');
            host.querySelector<HTMLButtonElement>('button.link')!.click();
            expect(settings.open).toHaveBeenCalledWith('security');
        });
    });

    it('names both keys as possible causes in the alarm', async () => {
        trust.markVerified(ME, PEER, NUMBER_B);

        const host = await render(NUMBER_A);

        expect(host.querySelector('.alarm-note')?.textContent).toContain('your own keys change');
    });
});
