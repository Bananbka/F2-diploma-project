import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { SuccessResponse } from '../models/api.model';
import { Sticker, StickerPack, StickerPackSummary } from '../models/sticker.model';
import { ConfigService } from './config.service';
import { StickerApiService } from './sticker-api.service';

const PACK = 'a0000000-0000-4000-8000-000000000001';
const API_URL = 'http://api.test/';

function ok<T>(data: T): SuccessResponse<T> {
    return { status: 'success', data, meta: null };
}

function pack(overrides: Partial<StickerPack> = {}): StickerPack {
    return { id: PACK, owner_id: 'user-1', title: 'Cats', is_public: false, stickers: [], ...overrides };
}

function summary(overrides: Partial<StickerPackSummary> = {}): StickerPackSummary {
    return {
        id: PACK,
        owner_id: 'user-1',
        title: 'Cats',
        is_public: false,
        sticker_count: 3,
        cover_image_url: null,
        ...overrides,
    };
}

describe('StickerApiService', () => {
    let service: StickerApiService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                { provide: ConfigService, useValue: { apiUrl: API_URL } },
            ],
        });

        service = TestBed.inject(StickerApiService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('creates a pack', () => {
        let result: StickerPack | undefined;
        service.createPack('Cats').subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}stickers/packs/`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({ title: 'Cats' });
        req.flush(ok(pack()));

        expect(result).toEqual(pack());
    });

    it('lists the tray', () => {
        const packs = [summary()];
        let result: StickerPackSummary[] | undefined;
        service.getMyPacks().subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}stickers/packs/mine`);
        expect(req.request.method).toBe('GET');
        req.flush(ok(packs));

        expect(result).toEqual(packs);
    });

    it('lists public packs with default paging and no search', () => {
        service.getPublicPacks().subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/public?limit=20&offset=0`);
        expect(req.request.method).toBe('GET');
        req.flush(ok([]));
    });

    it('lists public packs with a search term url-encoded', () => {
        service.getPublicPacks('cat packs', 10, 5).subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/public?limit=10&offset=5&search=cat%20packs`);
        req.flush(ok([]));
    });

    it('fetches one pack', () => {
        let result: StickerPack | undefined;
        service.getPack(PACK).subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}`);
        expect(req.request.method).toBe('GET');
        req.flush(ok(pack()));

        expect(result).toEqual(pack());
    });

    it('updates a pack with only the supplied fields', () => {
        service.updatePack(PACK, { is_public: true }).subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({ is_public: true });
        req.flush(ok(pack({ is_public: true })));
    });

    it('deletes a pack', () => {
        service.deletePack(PACK).subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}`);
        expect(req.request.method).toBe('DELETE');
        req.flush(ok({ message: 'Sticker pack deleted.' }));
    });

    it('adds a sticker', () => {
        const sticker: Sticker = { id: 's1', pack_id: PACK, image_url: 'url', emoji: '😀', position: 0 };
        let result: Sticker | undefined;

        service.addSticker(PACK, { image_url: 'url', emoji: '😀' }).subscribe((r) => (result = r));

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}/stickers`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({ image_url: 'url', emoji: '😀' });
        req.flush(ok(sticker));

        expect(result).toEqual(sticker);
    });

    it('deletes a sticker', () => {
        service.deleteSticker(PACK, 's1').subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}/stickers/s1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(ok({ message: 'Sticker deleted.' }));
    });

    it('reorders stickers as a bare array body', () => {
        service.reorderStickers(PACK, ['s2', 's1']).subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}/stickers/order`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual(['s2', 's1']);
        req.flush(ok({ message: 'Sticker order updated.' }));
    });

    it('subscribes to a pack', () => {
        service.subscribe(PACK).subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}/subscribe`);
        expect(req.request.method).toBe('POST');
        req.flush(ok({ message: 'Subscribed to sticker pack.' }));
    });

    it('unsubscribes from a pack', () => {
        service.unsubscribe(PACK).subscribe();

        const req = http.expectOne(`${API_URL}stickers/packs/${PACK}/subscribe`);
        expect(req.request.method).toBe('DELETE');
        req.flush(ok({ message: 'Unsubscribed from sticker pack.' }));
    });
});
