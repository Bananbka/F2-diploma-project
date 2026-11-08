import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { Appearance, DEFAULT_APPEARANCE } from '../models/appearance.model';
import { AppearanceApiService } from './appearance-api.service';
import { APPEARANCE_CACHE_KEY, APPEARANCE_PERSIST_DELAY_MS, AppearanceStore } from './appearance-store.service';
import { ToastService } from './toast.service';

describe('AppearanceStore', () => {
    let api: jasmine.SpyObj<AppearanceApiService>;
    let toast: jasmine.SpyObj<ToastService>;
    const remote: Appearance = { ...DEFAULT_APPEARANCE, font_size: 18 };

    function create(): AppearanceStore {
        api = jasmine.createSpyObj<AppearanceApiService>('AppearanceApiService', ['get', 'put', 'reset']);
        toast = jasmine.createSpyObj<ToastService>('ToastService', ['error', 'info']);
        api.get.and.returnValue(of(remote));
        api.put.and.callFake((a) => of(a));
        api.reset.and.returnValue(of(DEFAULT_APPEARANCE));
        TestBed.configureTestingModule({
            providers: [
                { provide: AppearanceApiService, useValue: api },
                { provide: ToastService, useValue: toast },
            ],
        });
        return TestBed.inject(AppearanceStore);
    }

    beforeEach(() => localStorage.removeItem(APPEARANCE_CACHE_KEY));
    afterEach(() => localStorage.removeItem(APPEARANCE_CACHE_KEY));

    it('starts from the cache, then the server value replaces it', async () => {
        localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, font_size: 20 }));
        const store = create();
        expect(store.value().font_size).toBe(20);

        await store.load();
        expect(store.value().font_size).toBe(18);
        expect(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY)!).font_size).toBe(18);
    });

    it('fails silently on load and keeps what it had', async () => {
        const store = create();
        api.get.and.returnValue(throwError(() => new Error('down')));
        await store.load();
        expect(store.value()).toEqual(DEFAULT_APPEARANCE);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('applies an update at once and persists once after the debounce', fakeAsync(() => {
        const store = create();
        store.update({ font_size: 16 });
        store.update({ font_size: 17 });
        store.update({ font_size: 19 });
        expect(store.value().font_size).toBe(19);
        expect(api.put).not.toHaveBeenCalled();

        tick(APPEARANCE_PERSIST_DELAY_MS);
        expect(api.put).toHaveBeenCalledTimes(1);
        expect(api.put.calls.mostRecent().args[0].font_size).toBe(19);
    }));

    it('reverts to the last confirmed value and notifies when the save fails', fakeAsync(() => {
        const store = create();
        api.put.and.returnValue(throwError(() => new Error('422')));
        store.update({ font_size: 20 });
        tick(APPEARANCE_PERSIST_DELAY_MS);

        expect(store.value()).toEqual(DEFAULT_APPEARANCE);
        expect(toast.error).toHaveBeenCalled();
    }));

    it('resets through DELETE and adopts the returned defaults', async () => {
        const store = create();
        store.update({ font_size: 20 });
        await store.reset();

        expect(api.reset).toHaveBeenCalled();
        expect(store.value()).toEqual(DEFAULT_APPEARANCE);
    });

    it('clear() returns to defaults, drops the cache and cancels a pending save', fakeAsync(() => {
        const store = create();
        store.update({ font_size: 20 });
        store.clear();
        tick(APPEARANCE_PERSIST_DELAY_MS);

        expect(store.value()).toEqual(DEFAULT_APPEARANCE);
        expect(localStorage.getItem(APPEARANCE_CACHE_KEY)).toBeNull();
        expect(api.put).not.toHaveBeenCalled();
    }));

    it('restores the previous value if the reset fails', async () => {
        const store = create();
        store.update({ font_size: 20 });
        api.reset.and.returnValue(throwError(() => new Error('500')));
        await store.reset();

        expect(store.value().font_size).toBe(20);
        expect(toast.error).toHaveBeenCalled();
    });
});
