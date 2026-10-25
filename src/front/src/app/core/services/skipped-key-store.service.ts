import { inject, Injectable, InjectionToken } from '@angular/core';

/** Where retained skipped keys live. `null` means IndexedDB is unavailable: memory only. */
export const SKIPPED_KEY_IDB = new InjectionToken<IDBFactory | null>('SKIPPED_KEY_IDB', {
    providedIn: 'root',
    factory: () => (typeof indexedDB === 'undefined' ? null : indexedDB),
});

export const SKIPPED_KEY_DB_NAME = new InjectionToken<string>('SKIPPED_KEY_DB_NAME', {
    providedIn: 'root',
    factory: () => 'ns-skipped-keys',
});

/** Hard ceiling across every chain. Per chain the ratchet already caps at MAX_RETAINED_SKIPPED. */
export const MAX_STORED_SKIPPED = 10_000;

export const SKIPPED_KEY_CAP = new InjectionToken<number>('SKIPPED_KEY_CAP', {
    providedIn: 'root',
    factory: () => MAX_STORED_SKIPPED,
});

/** The cap is checked every this many writes rather than on each one. */
const CAP_CHECK_EVERY = 64;

/** Retained keys undermine forward secrecy, so they expire even if never used. */
export const MAX_SKIPPED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const STORE = 'skipped';

/** An opaque stored entry. The service never sees a key, only the wrapped bytes. */
export interface StoredSkipped {
    /** `${chainId}|${index}` */
    id: string;
    chain: string;
    index: number;
    savedAt: number;
    iv: string;
    ct: string;
}

/**
 * Persistence for wrapped skipped keys: IndexedDB when it works, a Map when it does not.
 *
 * Holds ciphertext only (see `crypto/skipped-wrap.ts`); the KEK stays in `KeyStoreService`. Every
 * failure degrades to the in-memory map rather than surfacing, because the store is an
 * optimisation of what the ratchet can already re-derive from the grant � never a precondition for
 * opening a message. Chat and chain ids are stored in the clear as lookup keys; they are ids, not
 * content.
 */
@Injectable({ providedIn: 'root' })
export class SkippedKeyStore {
    private readonly factory = inject(SKIPPED_KEY_IDB);
    private readonly dbName = inject(SKIPPED_KEY_DB_NAME);
    private readonly cap = inject(SKIPPED_KEY_CAP);
    private writesSinceCheck = 0;

    private readonly memory = new Map<string, StoredSkipped>();
    private db: Promise<IDBDatabase | null> | null = null;

    /** True once we are running on the memory fallback. */
    get isMemoryOnly(): boolean {
        return this.factory === null || this.failed;
    }
    private failed = false;

    private open(): Promise<IDBDatabase | null> {
        if (this.factory === null || this.failed) {
            return Promise.resolve(null);
        }
        this.db ??= new Promise<IDBDatabase | null>((resolve) => {
            try {
                const request = this.factory!.open(this.dbName, 1);
                request.onupgradeneeded = () => {
                    const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('chain', 'chain');
                    store.createIndex('savedAt', 'savedAt');
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(this.degrade());
                request.onblocked = () => resolve(this.degrade());
            } catch {
                resolve(this.degrade());
            }
        });
        return this.db;
    }

    private degrade(): null {
        this.failed = true;
        return null;
    }

    private async run<T>(
        mode: IDBTransactionMode,
        work: (store: IDBObjectStore) => IDBRequest<T> | void,
        fallback: () => T
    ): Promise<T> {
        const db = await this.open();
        if (!db) {
            return fallback();
        }
        try {
            return await new Promise<T>((resolve, reject) => {
                const tx = db.transaction(STORE, mode);
                const request = work(tx.objectStore(STORE));
                tx.oncomplete = () => resolve((request ? request.result : undefined) as T);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch {
            this.degrade();
            return fallback();
        }
    }

    async put(entry: StoredSkipped): Promise<void> {
        await this.run(
            'readwrite',
            (store) => {
                store.put(entry);
            },
            () => {
                this.memory.set(entry.id, entry);
            }
        );
        this.writesSinceCheck += 1;
        if (this.writesSinceCheck >= CAP_CHECK_EVERY) {
            this.writesSinceCheck = 0;
            await this.enforceCap();
        }
    }

    async delete(id: string): Promise<void> {
        await this.run(
            'readwrite',
            (store) => {
                store.delete(id);
            },
            () => {
                this.memory.delete(id);
            }
        );
    }

    async forChain(chain: string): Promise<StoredSkipped[]> {
        const rows = await this.run<StoredSkipped[]>(
            'readonly',
            (store) => store.index('chain').getAll(chain),
            () => [...this.memory.values()].filter((entry) => entry.chain === chain)
        );
        return rows ?? [];
    }

    /**
     * Remove everything. Called on lock, logout, password change and account deletion.
     * Resolves true when nothing persistent remains; false when the wipe could not be confirmed
     * (the caller should say so rather than claim erasure). A failed clear falls back to deleting
     * the whole database.
     */
    async clear(): Promise<boolean> {
        this.memory.clear();
        if (this.factory === null) {
            return true;
        }
        const db = await this.open();
        if (db) {
            try {
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).clear();
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                    tx.onabort = () => reject(tx.error);
                });
                return true;
            } catch {
                // fall through to the heavier hammer
            }
        }
        return this.deleteDatabase();
    }

    private async deleteDatabase(): Promise<boolean> {
        const open = this.db ? await this.db.catch(() => null) : null;
        open?.close();
        this.db = null;
        try {
            return await new Promise<boolean>((resolve) => {
                const request = this.factory!.deleteDatabase(this.dbName);
                request.onsuccess = () => {
                    this.failed = false;
                    resolve(true);
                };
                request.onerror = () => resolve(false);
                request.onblocked = () => resolve(false);
            });
        } catch {
            return false;
        }
    }

    /** Drop entries saved before `cutoff` (epoch ms). */
    async pruneOlderThan(cutoff: number): Promise<void> {
        await this.run(
            'readwrite',
            (store) => {
                const cursor = store.index('savedAt').openCursor(IDBKeyRange.upperBound(cutoff, true));
                cursor.onsuccess = () => {
                    const hit = cursor.result;
                    if (hit) {
                        hit.delete();
                        hit.continue();
                    }
                };
            },
            () => {
                for (const [id, entry] of this.memory) {
                    if (entry.savedAt < cutoff) {
                        this.memory.delete(id);
                    }
                }
            }
        );
    }

    async count(): Promise<number> {
        return (
            (await this.run<number>(
                'readonly',
                (store) => store.count(),
                () => this.memory.size
            )) ?? 0
        );
    }

    /** Evict the oldest entries beyond the cap. */
    async enforceCap(): Promise<void> {
        const excess = (await this.count()) - this.cap;
        if (excess <= 0) {
            return;
        }
        await this.run(
            'readwrite',
            (store) => {
                let left = excess;
                const cursor = store.index('savedAt').openCursor();
                cursor.onsuccess = () => {
                    const hit = cursor.result;
                    if (hit && left > 0) {
                        hit.delete();
                        left -= 1;
                        hit.continue();
                    }
                };
            },
            () => {
                [...this.memory.values()]
                    .sort((a, b) => a.savedAt - b.savedAt)
                    .slice(0, excess)
                    .forEach((entry) => this.memory.delete(entry.id));
            }
        );
    }
}
