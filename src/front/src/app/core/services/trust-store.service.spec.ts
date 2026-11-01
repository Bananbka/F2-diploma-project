import { TestBed } from '@angular/core/testing';

import { TrustStoreService } from './trust-store.service';

const ME = 'a1111111-0000-4000-8000-000000000009';
const OTHER_ME = 'a2222222-0000-4000-8000-000000000008';
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
        expect(service.stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
    });

    it('reports a peer as verified once their number is confirmed', () => {
        service.markVerified(ME, PEER, NUMBER_A);

        const state = service.stateFor(ME, PEER, NUMBER_A);
        expect(state.kind).toBe('verified');
    });

    /**
     * The single most important assertion in this file. A key change is exactly what a server
     * substituting a public key produces, so it must never be reported as merely unverified — that
     * would silently re-trust the new key and lose the only signal the user has.
     */
    it('reports a changed number as changed, not as unverified', () => {
        service.markVerified(ME, PEER, NUMBER_A);

        const state = service.stateFor(ME, PEER, NUMBER_B);
        expect(state.kind).toBe('changed');
        expect(state.kind === 'changed' && state.previous).toBe(NUMBER_A);
    });

    it('compares digits only, so formatting differences are not a key change', () => {
        service.markVerified(ME, PEER, NUMBER_A);

        expect(service.stateFor(ME, PEER, NUMBER_A.replace(/ /g, '')).kind).toBe('verified');
    });

    it('returns to unverified when trust is cleared', () => {
        service.markVerified(ME, PEER, NUMBER_A);
        service.forget(ME, PEER);

        expect(service.stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
    });

    it('survives a new service instance, since detection depends on remembering', () => {
        service.markVerified(ME, PEER, NUMBER_A);

        const reloaded = new TrustStoreService();
        expect(reloaded.stateFor(ME, PEER, NUMBER_B).kind).toBe('changed');
    });

    /** Corrupt storage must fail closed — prompting a fresh comparison, never assuming trust. */
    it('treats unreadable storage as unverified rather than trusted', () => {
        localStorage.setItem('ns.trusted_peers', 'not json');

        const reloaded = new TrustStoreService();
        expect(reloaded.stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
    });

    it('keeps the same peer independent under two of my own accounts', () => {
        service.markVerified(ME, PEER, NUMBER_A);

        // A different account of mine computes a different number for the same, unchanged peer: that
        // is not a key change, it is a different relationship.
        expect(service.stateFor(OTHER_ME, PEER, NUMBER_B).kind).toBe('unverified');
        expect(service.stateFor(ME, PEER, NUMBER_A).kind).toBe('verified');

        service.markVerified(OTHER_ME, PEER, NUMBER_B);
        expect(service.stateFor(ME, PEER, NUMBER_A).kind).toBe('verified');
        expect(service.stateFor(OTHER_ME, PEER, NUMBER_B).kind).toBe('verified');

        service.forget(ME, PEER);
        expect(service.stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
        expect(service.stateFor(OTHER_ME, PEER, NUMBER_B).kind).toBe('verified');
    });

    it('still alarms on a genuine change of the pair number', () => {
        service.markVerified(OTHER_ME, PEER, NUMBER_B);

        expect(service.stateFor(OTHER_ME, PEER, NUMBER_A).kind).toBe('changed');
    });

    it('treats a legacy record keyed by the bare peer id as unverified, never as verified', () => {
        localStorage.setItem(
            'ns.trusted_peers',
            JSON.stringify({ [PEER]: { safetyNumber: NUMBER_A, verifiedAt: '2024-01-01T00:00:00Z' } })
        );

        const reloaded = new TrustStoreService();
        expect(reloaded.stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
        expect(reloaded.stateFor(ME, PEER, NUMBER_B).kind).toBe('unverified');
    });

    it('never forms a shared bucket from an empty id', () => {
        service.markVerified('', PEER, NUMBER_A);
        service.markVerified(ME, '', NUMBER_A);
        service.markVerified('', '', NUMBER_A);

        expect(service.stateFor('', PEER, NUMBER_A).kind).toBe('unverified');
        expect(service.stateFor(ME, '', NUMBER_A).kind).toBe('unverified');
        expect(service.stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
        expect(localStorage.getItem('ns.trusted_peers')).toBeNull();
        expect(() => service.forget('', PEER)).not.toThrow();
    });

    it('drops malformed stored records instead of letting them throw', () => {
        localStorage.setItem(
            'ns.trusted_peers',
            JSON.stringify({
                [`${ME}:${PEER}`]: { safetyNumber: 42, verifiedAt: 'x' },
                [`${ME}:other`]: null,
                [`${ME}:good`]: { safetyNumber: NUMBER_A, verifiedAt: '2024-01-01T00:00:00Z' },
            })
        );

        const reloaded = new TrustStoreService();
        expect(() => reloaded.stateFor(ME, PEER, NUMBER_A)).not.toThrow();
        expect(reloaded.stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
        expect(reloaded.stateFor(ME, 'good', NUMBER_A).kind).toBe('verified');
    });

    it('treats a non-object stored value as empty', () => {
        for (const raw of ['[]', '"x"', '7', 'null']) {
            localStorage.setItem('ns.trusted_peers', raw);
            expect(new TrustStoreService().stateFor(ME, PEER, NUMBER_A).kind).toBe('unverified');
        }
    });
});
