import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { SuccessResponse } from '../models/api.model';
import { ChatApiService } from './chat-api.service';

/** Mirrors `AttachmentFetchStatus` in `file_schemas.py`. */
type AttachmentFetchStatus = 'ok' | 'not_found' | 'gone' | 'too_large';

/** Mirrors `BatchAttachmentResult` in `file_schemas.py`. */
interface BatchAttachmentResult {
    object_key: string;
    status: AttachmentFetchStatus;
    content_type: string | null;
    content_base64: string | null;
    content_length: number | null;
}

/** The server's own cap on `object_keys` per call — see `MAX_BATCH_ATTACHMENT_KEYS`. */
const MAX_KEYS_PER_BATCH = 50;

/**
 * How many `too_large` objects are fetched individually at once, across all chats.
 *
 * These are by definition the big ones (each would have taken a batch call past the server's
 * 30 MB budget), so an unbounded burst would hold many multi-megabyte responses in memory at once
 * and occupy most of the browser's per-origin connections, stalling the ordinary API calls behind
 * them. Three keeps a screen of large videos moving without doing either.
 */
const MAX_CONCURRENT_SINGLE_FETCHES = 3;

interface PendingFetch {
    objectKey: string;
    /** Kept so a `too_large` entry can be re-requested through `ChatApiService.attachmentUrl`. */
    storedUrl: string;
    resolve: (bytes: ArrayBuffer) => void;
    reject: (error: unknown) => void;
}

/**
 * Collapses many `ensureDecrypted`-style attachment fetches into one `POST
 * /files/attachments/batch` call per chat, so a chat screen with N visible tiles pays one round
 * trip per batch rather than N — see `docs/tech-debt.md` §8.
 *
 * Scoped per chat id: the endpoint takes exactly one `chat_id`, so two chats' pending keys must
 * never be merged into the same call even if their `fetch()` calls land in the same tick.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentBatchService {
    private readonly http = inject(HttpClient);
    private readonly chatApi = inject(ChatApiService);

    /** One queue per chat id, drained (and deleted) on its own scheduled flush. */
    private readonly queues = new Map<string, PendingFetch[]>();
    /** Which chat ids already have a flush scheduled, so a burst of calls schedules only one. */
    private readonly scheduled = new Set<string>();

    /** Individual fetches waiting for a slot — see `MAX_CONCURRENT_SINGLE_FETCHES`. */
    private readonly singleQueue: (() => void)[] = [];
    private activeSingleFetches = 0;

    /**
     * Fetch one attachment's raw ciphertext bytes, batched with any other `fetch()` call for the
     * same chat that lands before the next flush.
     *
     * Mirrors `firstValueFrom(http.get(..., {responseType: 'arraybuffer'}))`'s contract: resolves
     * with the ciphertext bytes on success, rejects on `not_found`/`gone`/any HTTP failure — so a
     * caller's existing try/catch around the old direct fetch needs no change.
     *
     * An object the server leaves out of the batch as `too_large` is fetched on its own through
     * the streaming single-object endpoint and resolves here exactly as a batch hit would; the
     * caller cannot tell which transport served it.
     */
    fetch(chatId: string, storedUrl: string): Promise<ArrayBuffer> {
        const objectKey = this.chatApi.attachmentObjectKey(storedUrl);

        return new Promise<ArrayBuffer>((resolve, reject) => {
            const queue = this.queues.get(chatId) ?? [];
            queue.push({ objectKey, storedUrl, resolve, reject });
            this.queues.set(chatId, queue);
            this.scheduleFlush(chatId);
        });
    }

    private scheduleFlush(chatId: string): void {
        if (this.scheduled.has(chatId)) {
            return;
        }
        this.scheduled.add(chatId);

        // A microtask, not a timer: every `fetch()` call this is meant to coalesce comes from
        // `MessageBubbleComponent`s mounting (or becoming visible) within the same synchronous
        // rendering pass — the audio effect fires on render, and `appVisibleOnce` callbacks for a
        // freshly-scrolled batch of image/video tiles fire from the same IntersectionObserver
        // callback. A microtask drains only after all of that synchronous work finishes, so it
        // coalesces everything from one pass without adding the extra latency a `setTimeout(0)`
        // would (a timer waits for the next macrotask/paint, which is a real, visible delay before
        // media starts decrypting). It also doesn't need a cross-browser minimum-delay fixup the
        // way a 0ms timer does.
        queueMicrotask(() => {
            this.scheduled.delete(chatId);
            void this.flush(chatId);
        });
    }

    private async flush(chatId: string): Promise<void> {
        const queue = this.queues.get(chatId);
        this.queues.delete(chatId);
        if (!queue || queue.length === 0) {
            return;
        }

        // Dedupe keys: two attachments could theoretically share an object key, and every pending
        // entry for that key must still be resolved/rejected individually below.
        const uniqueKeys = [...new Set(queue.map((entry) => entry.objectKey))];

        // Chunks are independent calls, issued concurrently rather than one-after-another — a
        // chat with 50+ pending keys at once should not pay the extra round-trip latency of
        // waiting for the first chunk before starting the second.
        const chunks: Promise<void>[] = [];
        for (let start = 0; start < uniqueKeys.length; start += MAX_KEYS_PER_BATCH) {
            const chunk = uniqueKeys.slice(start, start + MAX_KEYS_PER_BATCH);
            const entriesForChunk = queue.filter((entry) => chunk.includes(entry.objectKey));
            chunks.push(this.flushChunk(chatId, chunk, entriesForChunk));
        }
        await Promise.all(chunks);
    }

    private async flushChunk(chatId: string, objectKeys: string[], entries: PendingFetch[]): Promise<void> {
        try {
            const response = await firstValueFrom(
                this.http.post<SuccessResponse<BatchAttachmentResult[]>>(this.chatApi.attachmentsBatchUrl(), {
                    chat_id: chatId,
                    object_keys: objectKeys,
                })
            );

            const byKey = new Map(response.data.map((result) => [result.object_key, result]));
            // Grouped by key so an object two tiles asked for is downloaded once, not per tile.
            const oversized = new Map<string, PendingFetch[]>();
            for (const entry of entries) {
                const result = byKey.get(entry.objectKey);
                if (result?.status === 'too_large') {
                    // Not an error about the object: it is authorised and present, it just did not
                    // fit in this call's byte budget. Rejecting here would leave the tile in an
                    // error state for something a plain GET serves.
                    const sharing = oversized.get(entry.objectKey) ?? [];
                    sharing.push(entry);
                    oversized.set(entry.objectKey, sharing);
                    continue;
                }
                if (!result|| result.status !== 'ok' || result.content_base64 === null) {
                    entry.reject(
                        new Error(`attachment ${entry.objectKey} unavailable: ${result?.status ?? 'missing'}`)
                    );
                    continue;
                }
                entry.resolve(base64ToArrayBuffer(result.content_base64));
            }

            // Not awaited: the entries that did fit are already settled, and the flush that issued
            // this chunk has nothing further to do with the stragglers.
            for (const sharing of oversized.values()) {
                void this.fetchSingle(chatId, sharing);
            }
        } catch (error) {
            // The whole HTTP call failed (network error, 403, rate limited, ...) — every entry in
            // this chunk must settle rather than hang.
            for (const entry of entries) {
                entry.reject(error);
            }
        }
    }

    /**
     * Fetch one object through `GET /files/attachments/{chat_id}/{object_key}` and settle every
     * entry waiting on it. A failure here is the real `HttpErrorResponse`, passed through as-is —
     * the same thing a caller got from the direct fetch this service replaced.
     */
    private async fetchSingle(chatId: string, entries: PendingFetch[]): Promise<void> {
        await this.acquireSingleSlot();
        try {
            const bytes = await firstValueFrom(
                this.http.get(this.chatApi.attachmentUrl(chatId, entries[0].storedUrl), {
                    responseType: 'arraybuffer',
                })
            );
            entries.forEach((entry, index) => {
                // The batch path decodes a separate buffer per entry, so no two callers ever share
                // one. Keep that true here: a caller that transfers or detaches its buffer must not
                // be able to empty another tile's copy.
                entry.resolve(index === 0 ? bytes : bytes.slice(0));
            });
        } catch (error) {
            for (const entry of entries) {
                entry.reject(error);
            }
        } finally {
            this.releaseSingleSlot();
        }
    }

    private acquireSingleSlot(): Promise<void> {
        if (this.activeSingleFetches < MAX_CONCURRENT_SINGLE_FETCHES) {
            this.activeSingleFetches++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.singleQueue.push(resolve));
    }

    private releaseSingleSlot(): void {
        const next = this.singleQueue.shift();
        if (next) {
            // The slot passes straight to the next waiter, so the count does not change.
            next();
            return;
        }
        this.activeSingleFetches--;
    }
}

/**
 * Plain (padded, `+`/`/` alphabet) base64 decode, as returned by `content_base64`.
 *
 * Not `b64uDecode` in `core/crypto/primitives.ts` — that's the base64url variant used for key
 * material, with a different alphabet and no padding. Reusing it here would silently mis-decode
 * the ciphertext bytes on any value containing `+`, `/` or padding.
 */
function base64ToArrayBuffer(value: string): ArrayBuffer {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
