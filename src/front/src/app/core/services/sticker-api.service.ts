import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import { Sticker, StickerPack, StickerPackSummary } from '../models/sticker.model';
import { ConfigService } from './config.service';

/** `POST /stickers/packs/{id}/stickers` body. `position` lets a manage screen insert mid-list. */
export interface StickerCreateRequest {
    image_url: string;
    emoji: string;
    position?: number;
}

/**
 * `PATCH /stickers/packs/{id}` body. Both fields are optional and, like `PATCH /profile/me`, an
 * explicit `null` on either is rejected server-side — omit a field instead of nulling it.
 */
export interface StickerPackUpdateRequest {
    title?: string;
    is_public?: boolean;
}

@Injectable({ providedIn: 'root' })
export class StickerApiService {
    private readonly http = inject(HttpClient);
    private readonly configService = inject(ConfigService);

    private get packsUrl(): string {
        return `${this.configService.apiUrl}stickers/packs/`;
    }

    createPack(title: string): Observable<StickerPack> {
        // No suffix follows `packsUrl` here, so its trailing slash would hit the backend's
        // non-slash `POST /stickers/packs` route and get redirected (307) rather than matched —
        // every other method below appends something after the slash, so this is the one call
        // site that needs it stripped.
        return this.http
            .post<SuccessResponse<StickerPack>>(this.packsUrl.replace(/\/$/, ''), { title })
            .pipe(map((r) => r.data));
    }

    /** The current user's tray: packs they own plus packs they have subscribed to. */
    getMyPacks(): Observable<StickerPackSummary[]> {
        return this.http.get<SuccessResponse<StickerPackSummary[]>>(`${this.packsUrl}mine`).pipe(map((r) => r.data));
    }

    getPublicPacks(search?: string, limit = 20, offset = 0): Observable<StickerPackSummary[]> {
        let url = `${this.packsUrl}public?limit=${limit}&offset=${offset}`;
        if (search) {
            url += `&search=${encodeURIComponent(search)}`;
        }
        return this.http.get<SuccessResponse<StickerPackSummary[]>>(url).pipe(map((r) => r.data));
    }

    getPack(packId: string): Observable<StickerPack> {
        return this.http.get<SuccessResponse<StickerPack>>(`${this.packsUrl}${packId}`).pipe(map((r) => r.data));
    }

    /**
     * Resolves the pack a sticker image belongs to — used when a sticker is tapped inside a message.
     * Rejects with 404 `STICKER_PACK_UNAVAILABLE` when the pack was deleted, made private, or the url
     * is not a pack sticker at all; callers must show that as its own state rather than swallow it.
     */
    getPackByUrl(url: string): Observable<StickerPack> {
        return this.http
            .get<SuccessResponse<StickerPack>>(
                `${this.configService.apiUrl}stickers/by-url?url=${encodeURIComponent(url)}`
            )
            .pipe(map((r) => r.data));
    }

    updatePack(packId: string, data: StickerPackUpdateRequest): Observable<StickerPack> {
        return this.http
            .patch<SuccessResponse<StickerPack>>(`${this.packsUrl}${packId}`, data)
            .pipe(map((r) => r.data));
    }

    deletePack(packId: string): Observable<unknown> {
        return this.http.delete<SuccessResponse<unknown>>(`${this.packsUrl}${packId}`).pipe(map((r) => r.data));
    }

    addSticker(packId: string, data: StickerCreateRequest): Observable<Sticker> {
        return this.http
            .post<SuccessResponse<Sticker>>(`${this.packsUrl}${packId}/stickers`, data)
            .pipe(map((r) => r.data));
    }

    deleteSticker(packId: string, stickerId: string): Observable<unknown> {
        return this.http
            .delete<SuccessResponse<unknown>>(`${this.packsUrl}${packId}/stickers/${stickerId}`)
            .pipe(map((r) => r.data));
    }

    /** `orderedStickerIds` must be the pack's exact existing id set — the server rejects a partial list. */
    reorderStickers(packId: string, orderedStickerIds: string[]): Observable<unknown> {
        return this.http
            .put<SuccessResponse<unknown>>(`${this.packsUrl}${packId}/stickers/order`, orderedStickerIds)
            .pipe(map((r) => r.data));
    }

    /** Adds a PUBLIC pack to the caller's tray without copying its stickers. */
    subscribe(packId: string): Observable<unknown> {
        return this.http
            .post<SuccessResponse<unknown>>(`${this.packsUrl}${packId}/subscribe`, {})
            .pipe(map((r) => r.data));
    }

    unsubscribe(packId: string): Observable<unknown> {
        return this.http
            .delete<SuccessResponse<unknown>>(`${this.packsUrl}${packId}/subscribe`)
            .pipe(map((r) => r.data));
    }
}
