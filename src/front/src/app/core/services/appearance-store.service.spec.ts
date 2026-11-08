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
        api = jasmine.createSpyObj<AppearanceApiService>('AppearanceApiService', [
            'get',
            'put',
            'reset',
            'uploadBackgroundImage',
            'deleteBackgroundImage',
            'fetchBackgroundImage',
        ]);
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

    describe('background image and shape', () => {
        const file = (type: string, size = 10) => new File([new Uint8Array(size)], 'bg', { type });

        it('loads a cached document that predates the new fields with defaults filled in', () => {
            localStorage.setItem(
                APPEARANCE_CACHE_KEY,
                JSON.stringify({
                    font_size: 16,
                    font_family: 'inter',
                    own_bubble_color: null,
                    other_bubble_color: null,
                    background: { kind: 'default', color: null, gradient: null },
                    version: 1,
                })
            );
            const store = create();
            expect(store.value().bubble_radius).toBe(19);
            expect(store.value().background_image_version).toBeNull();
            expect(store.value().background.image).toBeNull();
        });

        it('refuses an unsupported type or an oversized file without calling the server', async () => {
            const store = create();
            expect(await store.uploadBackgroundImage(file('image/gif'))).toEqual({
                ok: false,
                message: 'Use a JPEG, PNG or WebP image.',
            });
            const big = await store.uploadBackgroundImage(file('image/png', 5 * 1024 * 1024 + 1));
            expect(big.ok).toBeFalse();
            expect(api.uploadBackgroundImage).not.toHaveBeenCalled();
        });

        it('uploads, then selects the image kind with default tuning', fakeAsync(() => {
            const store = create();
            api.uploadBackgroundImage.and.returnValue(of({ ...DEFAULT_APPEARANCE, background_image_version: 'v7' }));
            let result: unknown;
            void store.uploadBackgroundImage(file('image/webp')).then((r) => (result = r));
            tick();
            expect(result).toEqual({ ok: true });
            expect(store.value().background.kind).toBe('image');
            expect(store.value().background.image).toEqual(
                jasmine.objectContaining({ fit: 'cover', zoom: 100, dim: 0, blur: 0, version: 'v7' })
            );
            expect(store.value().background_image_version).toBe('v7');
            tick(APPEARANCE_PERSIST_DELAY_MS);
            expect(api.put).toHaveBeenCalledTimes(1);
        }));

        it('turns 415 and 413 into readable messages', async () => {
            const store = create();
            api.uploadBackgroundImage.and.returnValue(throwError(() => ({ status: 415 })));
            expect((await store.uploadBackgroundImage(file('image/png'))) as { message: string }).toEqual(
                jasmine.objectContaining({ ok: false, message: jasmine.stringMatching(/not supported/) })
            );
            api.uploadBackgroundImage.and.returnValue(throwError(() => ({ status: 413 })));
            expect((await store.uploadBackgroundImage(file('image/png'))) as { message: string }).toEqual(
                jasmine.objectContaining({ ok: false, message: jasmine.stringMatching(/too large/) })
            );
        });

        it('removes the image through DELETE and adopts the returned document', async () => {
            const store = create();
            store.update({ background_image_version: 'v1' });
            api.deleteBackgroundImage.and.returnValue(of(DEFAULT_APPEARANCE));
            expect(await store.removeBackgroundImage()).toBeTrue();
            expect(store.value().background_image_version).toBeNull();
            expect(store.value().background.kind).toBe('default');
        });

        it('keeps state and tells the user when removal fails', async () => {
            const store = create();
            api.deleteBackgroundImage.and.returnValue(throwError(() => new Error('x')));
            expect(await store.removeBackgroundImage()).toBeFalse();
            expect(toast.error).toHaveBeenCalled();
        });
    });
});
