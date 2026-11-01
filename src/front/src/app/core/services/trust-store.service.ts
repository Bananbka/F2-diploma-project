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
 * Keyed by the *pair* `<own user id>:<peer user id>`, not by the peer alone. A safety number is
 * computed from both parties' keys, so the same peer yields a different number under each of the
 * user's own accounts (and after the user's own keys change). Keyed by peer alone, signing in as a
 * second account on the same browser made every previously verified peer look like a substituted
 * key. Still per person rather than per device: the user compares a number with a person.
 *
 * Records written before the pair keying were stored under the bare peer id. They are never read:
 * the pair key cannot collide with a bare id, so such a peer simply reads as unverified. That is the
 * safe direction. Converting them would claim a verification for a number that was computed under an
 * account we can no longer identify.
 */
@Injectable({ providedIn: 'root' })
export class TrustStoreService {
    private readonly records = signal(this.read());

    stateFor(selfId: string, peerId: string, currentSafetyNumber: string): TrustState {
        const key = this.key(selfId, peerId);
        const record = key ? this.records()[key] : undefined;

        if (!record) {
            return { kind: 'unverified' };
        }
        if (this.normalise(record.safetyNumber) !== this.normalise(currentSafetyNumber)) {
            return { kind: 'changed', previous: record.safetyNumber, verifiedAt: record.verifiedAt };
        }
        return { kind: 'verified', verifiedAt: record.verifiedAt };
    }

    /** Record that the user compared this number out of band and it matched. */
    markVerified(selfId: string, peerId: string, safetyNumber: string): void {
        const key = this.key(selfId, peerId);
        if (!key) {
            return;
        }
        this.write({
            ...this.records(),
            [key]: { safetyNumber, verifiedAt: new Date().toISOString() },
        });
    }

    /** Drop the record, returning the peer to unverified. */
    forget(selfId: string, peerId: string): void {
        const key = this.key(selfId, peerId);
        if (!key) {
            return;
        }
        const next = { ...this.records() };
        delete next[key];
        this.write(next);
    }

    /** Null when either id is empty: such a key would put unrelated pairs in one shared bucket. */
    private key(selfId: string, peerId: string): string | null {
        return selfId && peerId ? `${selfId}:${peerId}` : null;
    }

    private normalise(value: string): string {
        return value.replace(/\D/g, '');
    }

    private read(): Record<string, TrustRecord> {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return {};
            }
            // Tampered or hand-edited storage must not be able to make the comparison throw: keep only
            // entries that really are records, drop the rest (those peers read as unverified).
            const valid: Record<string, TrustRecord> = {};
            for (const [key, value] of Object.entries(parsed)) {
                const record = value as Partial<TrustRecord> | null;
                if (record && typeof record.safetyNumber === 'string' && typeof record.verifiedAt === 'string') {
                    valid[key] = { safetyNumber: record.safetyNumber, verifiedAt: record.verifiedAt };
                }
            }
            return valid;
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
