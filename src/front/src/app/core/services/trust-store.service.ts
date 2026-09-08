import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'ns.trusted_peers';

interface TrustRecord {
    safetyNumber: string;
    verifiedAt: string;
}

export type TrustState =
    /** Never compared out of band. */
    | { kind: 'unverified' }
    /** Compared, matched, and unchanged since. */
    | { kind: 'verified'; verifiedAt: string }
    /**
     * The peer's key changed after we marked them verified.
     *
     * The single most important state on this screen: it is exactly what a server substituting a
     * public key would produce, and it must be shown loudly rather than silently re-trusted.
     */
    | { kind: 'changed'; previous: string; verifiedAt: string };

/**
 * Remembers which safety numbers the user has confirmed out of band.
 *
 * Persisted in localStorage, unlike anything in `KeyStoreService`. That is deliberate and safe: a
 * safety number is a public fingerprint, so disclosure costs nothing — while *forgetting* it costs
 * the entire defence, because a key change can only be detected against a remembered value.
 *
 * Keyed by user id rather than device id: the user compares a number with a person.
 */
@Injectable({ providedIn: 'root' })
export class TrustStoreService {
    private readonly records = signal(this.read());

    stateFor(userId: string, currentSafetyNumber: string): TrustState {
        const record = this.records()[userId];

        if (!record) {
            return { kind: 'unverified' };
        }
        if (this.normalise(record.safetyNumber) !== this.normalise(currentSafetyNumber)) {
            return { kind: 'changed', previous: record.safetyNumber, verifiedAt: record.verifiedAt };
        }
        return { kind: 'verified', verifiedAt: record.verifiedAt };
    }

    /** Record that the user compared this number out of band and it matched. */
    markVerified(userId: string, safetyNumber: string): void {
        this.write({
            ...this.records(),
            [userId]: { safetyNumber, verifiedAt: new Date().toISOString() },
        });
    }

    /** Drop the record, returning the peer to unverified. */
    forget(userId: string): void {
        const next = { ...this.records() };
        delete next[userId];
        this.write(next);
    }

    private normalise(value: string): string {
        return value.replace(/\D/g, '');
    }

    private read(): Record<string, TrustRecord> {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? (JSON.parse(raw) as Record<string, TrustRecord>) : {};
        } catch {
            // Corrupt or unavailable storage means every peer reads as unverified, which is the safe
            // direction to fail in — it prompts a fresh comparison rather than assuming trust.
            return {};
        }
    }

    private write(records: Record<string, TrustRecord>): void {
        this.records.set(records);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
        } catch {
            // Non-fatal: trust simply does not survive the session.
        }
    }
}
