import { TestBed } from '@angular/core/testing';
import { v4 as uuidv4 } from 'uuid';

import {
    SKIPPED_KEY_CAP,
    SKIPPED_KEY_DB_NAME,
    SKIPPED_KEY_IDB,
    SkippedKeyStore,
    StoredSkipped,
} from './skipped-key-store.service';

function entry(chain: string, index: number, savedAt = Date.now()): StoredSkipped {
    return { id: `${chain}|${index}`, chain, index, savedAt, iv: 'iv', ct: 'ct' };
}

describe('SkippedKeyStore', () => {
    function create(extra: object[] = []): SkippedKeyStore {
        TestBed.configureTestingModule({
            providers: [{ provide: SKIPPED_KEY_DB_NAME, useValue: `test-store-${uuidv4()}` }, ...extra],
        });
        return TestBed.inject(SkippedKeyStore);
    }

    it('stores, lists per chain, deletes and clears (IndexedDB)', async () => {
        const store = create();
        await store.put(entry('A', 1));
        await store.put(entry('A', 2));
        await store.put(entry('B', 1));

        expect((await store.forChain('A')).map((r) => r.index).sort()).toEqual([1, 2]);

        await store.delete('A|1');
        expect((await store.forChain('A')).map((r) => r.index)).toEqual([2]);

        expect(await store.clear()).toBeTrue();
        expect(await store.count()).toBe(0);
        expect(store.isMemoryOnly).toBeFalse();
    });

    it('prunes entries older than the cutoff', async () => {
        const store = create();
        await store.put(entry('A', 1, 1000));
        await store.put(entry('A', 2, 5000));

        await store.pruneOlderThan(3000);

        expect((await store.forChain('A')).map((r) => r.index)).toEqual([2]);
    });

    it('caps total storage, evicting the oldest first', async () => {
        const store = create([{ provide: SKIPPED_KEY_CAP, useValue: 3 }]);
        for (let i = 0; i < 5; i++) {
            await store.put(entry('A', i, 1000 + i));
        }

        await store.enforceCap();

        expect(await store.count()).toBe(3);
        expect((await store.forChain('A')).map((r) => r.index).sort()).toEqual([2, 3, 4]);
    });

    it('falls back to memory when IndexedDB is absent', async () => {
        const store = create([{ provide: SKIPPED_KEY_IDB, useValue: null }]);

        await store.put(entry('A', 1));
        expect(store.isMemoryOnly).toBeTrue();
        expect((await store.forChain('A')).length).toBe(1);

        await store.clear();
        expect(await store.count()).toBe(0);
    });

    it('reports false when the wipe cannot be confirmed', async () => {
        const broken = {
            open: () => {
                throw new Error('SecurityError');
            },
            deleteDatabase: () => {
                throw new Error('SecurityError');
            },
        } as unknown as IDBFactory;
        const store = create([{ provide: SKIPPED_KEY_IDB, useValue: broken }]);

        expect(await store.clear()).toBeFalse();
    });

    it('falls back to memory when opening IndexedDB throws', async () => {
        const broken = {
            open: () => {
                throw new Error('SecurityError');
            },
        } as unknown as IDBFactory;
        const store = create([{ provide: SKIPPED_KEY_IDB, useValue: broken }]);

        await store.put(entry('A', 1));

        expect(store.isMemoryOnly).toBeTrue();
        expect((await store.forChain('A')).length).toBe(1);
    });
});
