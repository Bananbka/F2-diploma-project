/** One sticker image inside a pack — `GET/POST /stickers/packs/{id}/stickers`. */
export interface Sticker {
    id: string;
    pack_id: string;
    image_url: string;
    emoji: string;
    position: number;
}

/** A pack with its full sticker list — `GET/POST/PATCH /stickers/packs/{id}`. */
export interface StickerPack {
    id: string;
    owner_id: string;
    title: string;
    is_public: boolean;
    stickers: Sticker[];
}

/**
 * The lighter list shape used by the tray and discovery screens — `GET /stickers/packs/mine` and
 * `GET /stickers/packs/public` return this instead of `StickerPack` so neither endpoint has to load
 * every sticker in every pack just to render a row.
 */
export interface StickerPackSummary {
    id: string;
    owner_id: string;
    title: string;
    is_public: boolean;
    sticker_count: number;
    cover_image_url: string | null;
}
