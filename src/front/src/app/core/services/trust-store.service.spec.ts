import { TestBed } from '@angular/core/testing';

import { TrustStoreService } from './trust-store.service';

const PEER = 'e4a1c0de-0000-4000-8000-000000000001';
const NUMBER_A = '04672 91834 52017 73649 18293 64751 39082 57164 82031 46918 73052 19374';
const NUMBER_B = '11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12345 67890';

describe('TrustStoreService', () => {
    let service: TrustStoreService;

    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({});
        service = TestBed.inject(TrustStoreService);
    });

    afterEach(() => localStorage.clear());

    it('reports an unknown peer as unverified', () => {
        expect(service.stateFor(PEER, NUMBER_A).kind).toBe('unverified');
    });

    it('reports a peer as verified once their number is confirmed', () => {
        service.markVerified(PEER, NUMBER_A);

        const state = service.stateFor(PEER, NUMBER_A);
        expect(state.kind).toBe('verified');
    });

    /**
     * The single most important assertion in this file. A key change is exactly what a server
     * substituting a public key produces, so it must never be reported as merely unverified — that
     * would silently re-trust the new key and lose the only signal the user has.
     */
    it('reports a changed number as changed, not as unverified', () => {
        service.markVerified(PEER, NUMBER_A);

        const state = service.stateFor(PEER, NUMBER_B);
        expect(state.kind).toBe('changed');
        expect(state.kind === 'changed' && state.previous).toBe(NUMBER_A);
    });

    it('compares digits only, so formatting differences are not a key change', () => {
        service.markVerified(PEER, NUMBER_A);

        expect(service.stateFor(PEER, NUMBER_A.replace(/ /g, '')).kind).toBe('verified');
    });

    it('returns to unverified when trust is cleared', () => {
        service.markVerified(PEER, NUMBER_A);
        service.forget(PEER);

        expect(service.stateFor(PEER, NUMBER_A).kind).toBe('unverified');
    });

    it('survives a new service instance, since detection depends on remembering', () => {
        service.markVerified(PEER, NUMBER_A);

        const reloaded = new TrustStoreService();
        expect(reloaded.stateFor(PEER, NUMBER_B).kind).toBe('changed');
    });

    /** Corrupt storage must fail closed — prompting a fresh comparison, never assuming trust. */
    it('treats unreadable storage as unverified rather than trusted', () => {
        localStorage.setItem('ns.trusted_peers', 'not json');

        const reloaded = new TrustStoreService();
        expect(reloaded.stateFor(PEER, NUMBER_A).kind).toBe('unverified');
    });
});
