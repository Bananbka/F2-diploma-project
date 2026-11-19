import { DestroyRef, inject, Injectable, signal } from '@angular/core';

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
 * The outcome of changing a confirmation. `unsaved` — it holds in this tab only (storage could not be
 * written). `refused` — nothing changed: clearing it would lift a refusal (`KeyChangeStateService`).
 */
export type TrustWriteResult = 'saved' | 'unsaved' | 'refused';

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
 *
 * Shared by every tab of this origin, so it is never treated as a private copy: a `storage` listener
 * adopts other tabs' writes, every write re-reads storage first and merges into what is there, and
 * the send path calls `refresh()` before it compares.
 */
@Injectable({ providedIn: 'root' })
export class TrustStoreService {
    private readonly records = signal(this.read());

    /**
     * Bumped whenever the set of confirmed records changes — here, or in another tab of this
     * browser. `KeyStoreService` stamps each sending chain with the value current when it verified
     * the roster and refuses to reuse a chain stamped with an older one: a chain wrapped while a
     * peer was unverified (or verified to a different number) was never checked against what the
     * user has confirmed since.
     */
    readonly revision = signal(0);

    /**
     * True while a write to storage failed and memory holds confirmations storage does not. Memory
     * is then authoritative: adopting the stored copy would silently drop a verification the user
     * just made.
     */
    private unsaved = false;

    /**
     * Set by `KeyChangeStateService`: true when clearing this pair's confirmation would lift an
     * outstanding refusal. A hook rather than an injection, because that service depends on this one.
     */
    private forgetGuard: ((selfId: string, peerId: string) => boolean) | null = null;

    constructor() {
        this.bindStorageEvents();
    }

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

    /**
     * Re-read the stored records and adopt them if another tab changed them. The send path calls
     * this right before comparing, so a verification made in another tab a moment ago is honoured
     * even if its `storage` event has not been delivered yet. A no-op when storage is unavailable:
     * the in-memory records are then the only copy and must not be replaced by nothing.
     */
    refresh(): void {
        if (this.unsaved) {
            return;
        }
        const stored = this.readStored();
        if (stored === null || this.sameRecords(stored, this.records())) {
            return;
        }
        this.records.set(stored);
        this.revision.update((n) => n + 1);
    }

    /**
     * Record that the user compared this number out of band and it matched. `unsaved` means the
     * record holds for this tab only, and the caller should say so rather than imply it will be
     * remembered.
     */
    markVerified(selfId: string, peerId: string, safetyNumber: string): TrustWriteResult {
        const key = this.key(selfId, peerId);
        if (!key) {
            return 'unsaved';
        }
        // Read-merge-write: another tab may have verified (or forgotten) someone else since this
        // tab last read, and writing our stale copy back would silently undo that.
        return this.write({
            ...this.latest(),
            [key]: { safetyNumber, verifiedAt: new Date().toISOString() },
        });
    }

    /**
     * Drop the record, returning the peer to unverified. Refused while a send is refused on a
     * changed number for this pair: clearing the confirmation would let that chat's next roster
     * check accept the refused keys on trust-on-first-use. Accepting a specific number is the way
     * out, never forgetting the old one.
     */
    forget(selfId: string, peerId: string): TrustWriteResult {
        const key = this.key(selfId, peerId);
        if (!key) {
            return 'unsaved';
        }
        if (this.forgetGuard?.(selfId, peerId)) {
            return 'refused';
        }
        // Read-merge-write, for the same reason as `markVerified`.
        const next = { ...this.latest() };
        delete next[key];
        return this.write(next);
    }

    /** See `forgetGuard`. */
    setForgetGuard(guard: (selfId: string, peerId: string) => boolean): void {
        this.forgetGuard = guard;
    }

    /**
     * Identifies the confirmation currently on record for this pair (when and to what), or null when
     * there is none. A refusal remembers the stamp it was recorded against, so a confirmation made
     * since — of any number — is recognisable as newer than the refusal.
     */
    recordStamp(selfId: string, peerId: string): string | null {
        const key = this.key(selfId, peerId);
        const record = key ? this.records()[key] : undefined;
        return record ? `${record.verifiedAt}|${this.normalise(record.safetyNumber)}` : null;
    }

    /** Null when either id is empty: such a key would put unrelated pairs in one shared bucket. */
    private key(selfId: string, peerId: string): string | null {
        return selfId && peerId ? `${selfId}:${peerId}` : null;
    }

    private normalise(value: string): string {
        return value.replace(/\D/g, '');
    }

    /**
     * Another tab's write arrives as a `storage` event (never delivered to the tab that wrote it).
     * Without this a second tab kept the records it read at startup for its whole life, and sent to a
     * peer verified elsewhere as if unverified. `key === null` is `localStorage.clear()`.
     *
     * Guarded for SSR, and for specs that construct the service with `new` outside any injector.
     */
    private bindStorageEvents(): void {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return;
        }
        const listener = (event: StorageEvent): void => {
            if (event.key === STORAGE_KEY || event.key === null) {
                this.refresh();
            }
        };
        window.addEventListener('storage', listener);
        try {
            inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', listener));
        } catch {
            // Constructed outside an injection context: nothing owns this instance's lifetime.
        }
    }

    /**
     * What is stored right now, or the in-memory copy when storage cannot be read at all — or when
     * memory holds a confirmation that could not be saved, which must not be overwritten by the
     * older stored copy on the next write.
     */
    private latest(): Record<string, TrustRecord> {
        return this.unsaved ? this.records() : (this.readStored() ?? this.records());
    }

    private sameRecords(a: Record<string, TrustRecord>, b: Record<string, TrustRecord>): boolean {
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length) {
            return false;
        }
        return keys.every(
            (key) => b[key]?.safetyNumber === a[key].safetyNumber && b[key]?.verifiedAt === a[key].verifiedAt
        );
    }

    private read(): Record<string, TrustRecord> {
        return this.readStored() ?? {};
    }

    /**
     * The stored records, or null when storage itself is unavailable. Unparseable or tampered
     * content is *not* null: it reads as no records, which is the safe direction to fail in — it
     * prompts a fresh comparison rather than assuming trust.
     */
    private readStored(): Record<string, TrustRecord> | null {
        let raw: string | null;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch {
            return null;
        }
        try {
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
            return {};
        }
    }

    private write(records: Record<string, TrustRecord>): TrustWriteResult {
        this.records.set(records);
        this.revision.update((n) => n + 1);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
            this.unsaved = false;
            return 'saved';
        } catch {
            // Non-fatal for this tab, but memory is now the only copy: keep it authoritative and
            // let the caller tell the user the confirmation will not survive the session.
            this.unsaved = true;
            return 'unsaved';
        }
    }
}
