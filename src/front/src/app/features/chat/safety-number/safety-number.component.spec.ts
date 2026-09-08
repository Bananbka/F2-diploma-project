import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { CryptoApiService } from '../../../core/services/crypto-api.service';
import { DirectoryService } from '../../../core/services/directory.service';
import { TrustStoreService } from '../../../core/services/trust-store.service';
import { SafetyNumberComponent } from './safety-number.component';

const CHAT = 'a0000000-0000-4000-8000-000000000001';
const PEER = 'bbbbbbbb-0000-4000-8000-000000000002';
const NUMBER_A = '04672 91834 52017 73649 18293 64751 39082 57164 82031 46918 73052 19374';
const NUMBER_B = '11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12345 67890';

describe('SafetyNumberComponent', () => {
    let fixture: ComponentFixture<SafetyNumberComponent>;
    let trust: TrustStoreService;

    async function render(safetyNumber: string): Promise<HTMLElement> {
        fixture.componentRef.setInput('chatId', CHAT);
        fixture.componentRef.setInput('userId', PEER);
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        void safetyNumber;
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        localStorage.clear();

        const cryptoApi = jasmine.createSpyObj<CryptoApiService>('CryptoApiService', ['getSafetyNumber']);
        cryptoApi.getSafetyNumber.and.returnValue(of(NUMBER_A));

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
                { provide: CryptoApiService, useValue: cryptoApi },
                { provide: DirectoryService, useValue: directory },
            ],
        }).compileComponents();

        trust = TestBed.inject(TrustStoreService);
        fixture = TestBed.createComponent(SafetyNumberComponent);
    });

    afterEach(() => localStorage.clear());

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
        trust.markVerified(PEER, NUMBER_B);

        const host = await render(NUMBER_A);

        expect(fixture.componentInstance.state()?.kind).toBe('changed');
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
        expect(host.textContent).toContain('has changed');
        // Accepting is an explicit act, never automatic.
        expect(host.textContent).toContain('I compared the new number');
    });

    it('confirms a peer whose number is unchanged since verification', async () => {
        trust.markVerified(PEER, NUMBER_A);

        const host = await render(NUMBER_A);

        expect(fixture.componentInstance.state()?.kind).toBe('verified');
        expect(host.textContent).toContain('Verified');
    });
});
