import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { Folder, FolderApiService } from './folder-api.service';
import { FolderStoreService } from './folder-store.service';

const WORK: Folder = { id: 'f1', title: 'Work', items: [{ chat_id: 'a' }, { chat_id: 'b' }] };

describe('FolderStoreService', () => {
    let api: jasmine.SpyObj<FolderApiService>;
    let store: FolderStoreService;

    beforeEach(() => {
        api = jasmine.createSpyObj<FolderApiService>('FolderApiService', [
            'getFolders',
            'createFolder',
            'updateFolder',
            'deleteFolder',
        ]);
        api.getFolders.and.returnValue(of([WORK]));
        TestBed.configureTestingModule({ providers: [{ provide: FolderApiService, useValue: api }] });
        store = TestBed.inject(FolderStoreService);
    });

    it('loads folders, and keeps the last list when a refresh fails', async () => {
        await store.load();
        expect(store.folders()).toEqual([WORK]);
        expect(store.loaded()).toBeTrue();

        api.getFolders.and.returnValue(throwError(() => new Error('down')));
        await store.load();
        expect(store.folders()).toEqual([WORK]);
        expect(store.loadFailed()).toBeTrue();

        api.getFolders.and.returnValue(of([WORK]));
        await store.load();
        expect(store.loadFailed()).toBeFalse();
    });

    it('stays unloaded, not empty-and-loaded, when the very first load fails', async () => {
        api.getFolders.and.returnValue(throwError(() => new Error('down')));
        await store.load();
        expect(store.loaded()).toBeFalse();
        expect(store.folders()).toEqual([]);
    });

    it('sends the whole resulting membership when toggling a chat, never a delta', async () => {
        await store.load();
        api.updateFolder.and.callFake((id, changes) =>
            of({ ...WORK, items: (changes.chat_ids ?? []).map((chat_id) => ({ chat_id })) })
        );
        await store.toggleChat('f1', 'c');
        expect(api.updateFolder).toHaveBeenCalledWith('f1', { chat_ids: ['a', 'b', 'c'] });
    });

    it('serialises quick toggles so the second starts from the first result', async () => {
        await store.load();
        api.updateFolder.and.callFake((id, changes) =>
            of({ ...WORK, items: (changes.chat_ids ?? []).map((chat_id) => ({ chat_id })) })
        );
        api.getFolders.and.callFake(() => of(store.folders()));

        const results = await Promise.all([store.toggleChat('f1', 'c'), store.toggleChat('f1', 'd')]);

        expect(results).toEqual([true, true]);
        expect(api.updateFolder.calls.argsFor(0)[1]).toEqual({ chat_ids: ['a', 'b', 'c'] });
        expect(api.updateFolder.calls.argsFor(1)[1]).toEqual({ chat_ids: ['a', 'b', 'c', 'd'] });
    });

    it('does not toggle a folder that is no longer there', async () => {
        expect(await store.toggleChat('gone', 'a')).toBeFalse();
        expect(api.updateFolder).not.toHaveBeenCalled();
    });

    it('renames without touching membership, and trims the title', async () => {
        api.updateFolder.and.returnValue(of(WORK));
        await store.update('f1', { title: '  Office ' });
        expect(api.updateFolder).toHaveBeenCalledWith('f1', { title: 'Office' });
    });

    it('reports failures instead of throwing', async () => {
        api.updateFolder.and.returnValue(throwError(() => new Error('no')));
        api.createFolder.and.returnValue(throwError(() => new Error('no')));
        api.deleteFolder.and.returnValue(throwError(() => new Error('no')));

        expect(await store.update('f1', { title: 'x' })).toBeFalse();
        expect(await store.create('x', [])).toBeNull();
        expect(await store.remove(WORK)).toBeFalse();
    });

    it('reloads after a delete', async () => {
        api.deleteFolder.and.returnValue(of({}));
        api.getFolders.and.returnValue(of([]));
        expect(await store.remove(WORK)).toBeTrue();
        expect(store.folders()).toEqual([]);
    });
});
