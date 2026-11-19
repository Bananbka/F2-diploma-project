import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { KeyChangeStateService } from './key-change-state.service';
import { TrustStoreService } from './trust-store.service';

const ME = 'a1111111-0000-4000-8000-000000000009';
const PEER = 'e4a1c0de-0000-4000-8000-000000000001';
const NUMBER_A = '04672 91834 52017 73649 18293 64751 39082 57164 82031 46918 73052 19374';
const NUMBER_B = '11111 22222 33333 44444 55555 66666 77777 88888 99999 00000 12345 67890';
const NUMBER_C = '22222 33333 44444 55555 66666 77777 88888 99999 00000 11111 23456 78901';

describe('KeyChangeStateService', () => {
    let service: KeyChangeStateService;
    let trust: TrustStoreService;

    /** A "page reload": fresh trust and key-change services over the same storage. */
    function reload(): { keyChange: KeyChangeStateService; trust: TrustStoreService } {
        const injector = Injector.create({
            parent: TestBed.inject(Injector),
            providers: [KeyChangeStateService, TrustStoreService],
        });
        return { keyChange: injector.get(KeyChangeStateService), trust: injector.get(TrustStoreService) };
    }

    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({});
        service = TestBed.inject(KeyChangeStateService);
        trust = TestBed.inject(TrustStoreService);
    });

    afterEach(() => localStorage.clear());

    /**
     * Observations are what let a key change block sending without a screen asking: the key store
     * notes every number it derives, and the state follows the record so a re-confirmation lifts it.
     */
    describe('observed numbers', () => {
        it('has no observed state until a number has been derived', () => {
            expect(service.observedState(ME, PEER)).toBeNull();
            expect(service.changedAmong(ME, [PEER])).toEqual([]);
        });

        it('reports a verified peer as changed once a different number is observed, and verified again when it is confirmed', () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            service.observe(ME, PEER, NUMBER_A);
            expect(service.observedState(ME, PEER)?.kind).toBe('verified');

            service.observe(ME, PEER, NUMBER_B);
            expect(service.observedState(ME, PEER)?.kind).toBe('changed');
            expect(service.changedAmong(ME, [PEER, 'someone-else'])).toEqual([PEER]);

            trust.markVerified(ME, PEER, NUMBER_B);
            expect(service.observedState(ME, PEER)?.kind).toBe('verified');
            expect(service.changedAmong(ME, [PEER])).toEqual([]);
        });

        it('never reports an unverified peer as changed, whatever is observed', () => {
            service.observe(ME, PEER, NUMBER_A);
            service.observe(ME, PEER, NUMBER_B);

            expect(service.observedState(ME, PEER)?.kind).toBe('unverified');
            expect(service.changedAmong(ME, [PEER])).toEqual([]);
        });

        it('keeps observations in memory only, and clears them with the session', () => {
            trust.markVerified(ME, PEER, NUMBER_A);
            service.observe(ME, PEER, NUMBER_B);

            expect(localStorage.getItem('ns.trusted_peers')).not.toContain(NUMBER_B);
            expect(reload().keyChange.observedState(ME, PEER)).toBeNull();

            service.clearSession();
            expect(service.observedState(ME, PEER)).toBeNull();
        });
    });

    /**
     * G5: an equivocating server can answer a batch lookup with the old keys while the roster the
     * send path checks carries new ones. The lookup must not be able to clear that alarm.
     */
    describe('roster versus lookup observations', () => {
        beforeEach(() => trust.markVerified(ME, PEER, NUMBER_A));

        it('never lets a lookup clear a change the roster observed', () => {
            service.observe(ME, PEER, NUMBER_B, 'roster');
            service.observe(ME, PEER, NUMBER_A, 'lookup');

            expect(service.observedState(ME, PEER)?.kind).toBe('changed');
            expect(service.blockingNumber(ME, PEER)).toBe(NUMBER_B);
        });

        it('lets a lookup raise an alarm', () => {
            service.observe(ME, PEER, NUMBER_A, 'roster');
            service.observe(ME, PEER, NUMBER_B, 'lookup');

            expect(service.observedState(ME, PEER)?.kind).toBe('changed');
            // Not a roster number: nothing to block on, the dialog shows its own lookup.
            expect(service.blockingNumber(ME, PEER)).toBeNull();
        });

        it('drops the blocking number once it is accepted', () => {
            service.observe(ME, PEER, NUMBER_B, 'roster');

            trust.markVerified(ME, PEER, NUMBER_B);

            expect(service.blockingNumber(ME, PEER)).toBeNull();
            expect(service.observedState(ME, PEER)?.kind).toBe('verified');
        });
    });

    /** Round 2, item 4: refusals are per chat and outlive other chats' observations. */
    describe('per-chat refusals', () => {
        const CHAT_A = 'c0000000-0000-4000-8000-0000000000aa';
        const CHAT_B = 'c0000000-0000-4000-8000-0000000000bb';

        beforeEach(() => {
            trust.markVerified(ME, PEER, NUMBER_A);
            service.observe(ME, PEER, NUMBER_B, 'roster');
            service.recordRefusal(CHAT_A, ME, PEER, NUMBER_B, NUMBER_A);
        });

        it("does not let another chat's unchanged roster replace a refused observation", () => {
            service.observe(ME, PEER, NUMBER_A, 'roster');

            expect(service.observedState(ME, PEER)?.kind).toBe('changed');
            expect(service.blockingNumber(ME, PEER, CHAT_A)).toBe(NUMBER_B);
        });

        it('scopes the refusal to its chat', () => {
            expect(service.refusalFor(CHAT_A, ME, PEER)).toEqual(
                jasmine.objectContaining({ current: NUMBER_B, previous: NUMBER_A })
            );
            expect(service.refusalFor(CHAT_B, ME, PEER)).toBeNull();
            expect(service.refusedPeers(CHAT_A, ME)).toEqual([PEER]);
            expect(service.refusedPeers(CHAT_B, ME)).toEqual([]);
        });

        it('lapses when that number is confirmed', () => {
            trust.markVerified(ME, PEER, NUMBER_B);

            expect(service.refusalFor(CHAT_A, ME, PEER)).toBeNull();
            expect(service.refusedPeers(CHAT_A, ME)).toEqual([]);
        });

        it('is gone once the chat clears it', () => {
            service.clearRefusal(CHAT_A, ME, PEER);

            expect(service.refusalFor(CHAT_A, ME, PEER)).toBeNull();
        });

        /** Round 3, B: a reload or a second tab must not forget a refusal. */
        it('survives a reload', () => {
            const { keyChange } = reload();

            expect(keyChange.refusalFor(CHAT_A, ME, PEER)?.current).toBe(NUMBER_B);
        });

        it('reaches another tab through the storage event', () => {
            const other = reload().keyChange;
            other.recordRefusal(CHAT_B, ME, PEER, NUMBER_C, NUMBER_A);
            expect(service.refusalFor(CHAT_B, ME, PEER))
                .withContext('no event yet')
                .toBeNull();

            window.dispatchEvent(new StorageEvent('storage', { key: 'ns.refusals' }));

            expect(service.refusalFor(CHAT_B, ME, PEER)?.current).toBe(NUMBER_C);
        });

        it('refuses "Clear verification" while the refusal is outstanding, here and after a reload', () => {
            expect(trust.forget(ME, PEER)).toBe('refused');
            expect(trust.stateFor(ME, PEER, NUMBER_A).kind)
                .withContext('record kept')
                .toBe('verified');

            const reloaded = reload();
            expect(reloaded.trust.forget(ME, PEER)).toBe('refused');
        });

        it('allows clearing again once the refused number is accepted', () => {
            trust.markVerified(ME, PEER, NUMBER_B);

            expect(trust.forget(ME, PEER)).toBe('saved');
        });

        /**
         * Round 3, C: confirming any *other* number supersedes the refusal — the record is newer than
         * it — so the chat's next roster check decides afresh instead of staying blocked on N1.
         */
        it('is superseded when a different number is confirmed after it', () => {
            trust.markVerified(ME, PEER, NUMBER_C);

            expect(service.refusalFor(CHAT_A, ME, PEER)).toBeNull();
            expect(service.refusedPeers(CHAT_A, ME)).toEqual([]);
            expect(service.hasPendingRefusal(ME, PEER)).toBeFalse();
        });

        it('drops malformed stored refusals instead of letting them throw', () => {
            localStorage.setItem(
                'ns.refusals',
                JSON.stringify({ [`${CHAT_B}|${ME}:${PEER}`]: { current: 7 }, other: null })
            );

            expect(() => reload().keyChange.refusalFor(CHAT_B, ME, PEER)).not.toThrow();
            expect(reload().keyChange.refusalFor(CHAT_B, ME, PEER)).toBeNull();
        });

        it('carries whether our own devices were part of the change', () => {
            expect(service.ownDevicesChangedIn(CHAT_A, ME)).toBeFalse();

            service.recordRefusal(CHAT_A, ME, PEER, NUMBER_C, NUMBER_A, true);

            expect(service.ownDevicesChangedIn(CHAT_A, ME)).toBeTrue();
            expect(service.ownDevicesChangedIn(CHAT_B, ME)).toBeFalse();
        });
    });
});
