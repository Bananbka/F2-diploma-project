import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { MessageResponse } from '../models/crypto.model';
import { isObjectId, TEXT_CONTENT } from '../models/message-payload';
import { PollControl } from '../polls/poll-tally';
import { ChatApiService } from './chat-api.service';
import { DecryptedMessage, MessageService } from './message.service';

const PAGE_SIZE = 100;
/** A hard stop so a hostile or runaway poll cannot make the client page forever. */
const MAX_PAGES = 50;
/** Backoff for pulling grants when some votes arrived before their sender's key. */
const RETRY_DELAYS = [1500, 5000, 12000];

export interface PollEntry {
    /** Ascending by message id, deduplicated. */
    controls: PollControl[];
    /** A full load succeeded or is under way. Reset on failure so a later render retries. */
    requested: boolean;
    loading: boolean;
    error: boolean;
    /** The page cap was hit: the tally may be missing the oldest votes. */
    truncated: boolean;
    /**
     * Votes may have been cast while this poll was not being watched (another chat was open, or
     * the socket was down). The next render reloads it instead of trusting what is held.
     */
    stale: boolean;
}

const EMPTY: PollEntry = {
    controls: [],
    requested: false,
    loading: false,
    error: false,
    truncated: false,
    stale: false,
};

/** Collapse a decrypt result into what the tally needs. */
export function toPollControl(message: DecryptedMessage, raw: MessageResponse): PollControl {
    return {
        id: message.id,
        senderId: message.senderId,
        createdAt: message.createdAt,
        pollMessageId: raw.poll_message_id ?? null,
        // Opened, signature checked, and flagged as control by the server. Anything less is ignored.
        trusted: message.status === 'ok' && message.senderVerified && message.isControl === true,
        content: message.content ?? TEXT_CONTENT,
    };
}

/**
 * Holds the votes and closes of the polls on screen.
 *
 * A poll's results are not stored anywhere: they are recomputed from its control messages, which
 * are fetched on demand (when a poll bubble first renders), kept current from the socket, and
 * tallied by `tallyPoll`. Nothing is persisted - the plaintext of a vote is as sensitive as any
 * other message. The server supplies the list and its order, so the tally is only as trustworthy
 * as the server's willingness to return every vote (docs/crypto-spec-v1.md 4.7).
 */
@Injectable({ providedIn: 'root' })
export class PollStoreService {
    private readonly chatApi = inject(ChatApiService);
    private readonly messages = inject(MessageService);

    private readonly entries = signal(new Map<string, PollEntry>());
    /**
     * Raw controls we could not open yet, per poll, with the chat they came from. The chat id is
     * stored beside them: a retry must decrypt with the chat the votes belong to, never with
     * whichever chat happens to be open when the timer fires.
     */
    private readonly unresolved = new Map<string, { chatId: string; raws: MessageResponse[] }>();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly inflight = new Map<string, Promise<void>>();

    /** Signal-backed: reading this inside a `computed` re-evaluates it when the poll's votes change. */
    controls(pollId: string): readonly PollControl[] {
        return (this.entries().get(pollId) ?? EMPTY).controls;
    }

    state(pollId: string): Pick<PollEntry, 'loading' | 'error' | 'truncated' | 'requested' | 'stale'> {
        return this.entries().get(pollId) ?? EMPTY;
    }

    /**
     * Load every vote of a poll. A no-op while a good, current copy is held; reloads after a failure
     * or when the copy may be out of date (see `markAllStale`).
     */
    ensureLoaded(chatId: string, pollId: string): Promise<void> {
        if (!isObjectId(pollId)) {
            return Promise.resolve();
        }
        const existing = this.inflight.get(pollId);
        if (existing) {
            return existing;
        }
        const entry = this.entries().get(pollId);
        if (entry?.requested && !entry.stale && !entry.error) {
            return Promise.resolve();
        }
        return this.load(chatId, pollId);
    }

    reload(chatId: string, pollId: string): Promise<void> {
        return this.inflight.get(pollId) ?? this.load(chatId, pollId);
    }

    /** Re-fetch every poll that was loaded for this chat (after a socket gap). */
    async reloadRequested(chatId: string, pollIds: Iterable<string>): Promise<void> {
        for (const pollId of pollIds) {
            if (this.entries().get(pollId)?.requested) {
                await this.reload(chatId, pollId);
            }
        }
    }

    /**
     * Note that nobody was watching: events for other chats are not decrypted, so every held tally
     * may be missing votes. Called when the open conversation changes; bubbles reload on render.
     */
    markAllStale(): void {
        this.entries.update((map) => {
            if (map.size === 0) {
                return map;
            }
            const next = new Map<string, PollEntry>();
            for (const [pollId, entry] of map) {
                next.set(pollId, entry.requested ? { ...entry, stale: true } : entry);
            }
            return next;
        });
    }

    private load(chatId: string, pollId: string): Promise<void> {
        this.patch(pollId, { requested: true, loading: true, error: false });

        const run = (async () => {
            try {
                const { raws, truncated } = await this.fetchRaw(chatId, pollId);
                const stuck: MessageResponse[] = [];
                const controls: PollControl[] = [];

                // Ascending: the receiver ratchet only moves forward, so older indices come first.
                for (const raw of raws) {
                    const decrypted = await this.messages.decrypt(chatId, raw);
                    controls.push(toPollControl(decrypted, raw));
                    if (decrypted.status === 'no_key') {
                        stuck.push(raw);
                    }
                }

                this.addControls(pollId, controls);
                this.patch(pollId, { truncated, stale: false });
                this.trackUnresolved(chatId, pollId, stuck);
            } catch {
                // Not "requested": a failed load must be retryable, by the card's button or by the
                // next render, rather than leaving a silent empty tally.
                this.patch(pollId, { error: true, requested: false });
            } finally {
                this.patch(pollId, { loading: false });
                this.inflight.delete(pollId);
            }
        })();

        this.inflight.set(pollId, run);
        return run;
    }

    /**
     * Fetch every control message of a poll, oldest first. Pure transport: no state is touched,
     * which is what lets the export reuse it for chats that are not open.
     */
    async fetchRaw(
        chatId: string,
        pollId: string,
        shouldStop: () => boolean = () => false
    ): Promise<{ raws: MessageResponse[]; truncated: boolean }> {
        const pages: MessageResponse[][] = [];
        let before: string | undefined;
        let truncated = false;

        for (let page = 0; ; page += 1) {
            if (shouldStop()) {
                break;
            }
            if (page >= MAX_PAGES) {
                truncated = true;
                break;
            }
            const batch = await firstValueFrom(this.chatApi.getPollVotes(chatId, pollId, PAGE_SIZE, before));
            pages.push(batch);
            if (batch.length < PAGE_SIZE) {
                break;
            }
            before = batch[batch.length - 1]._id;
        }

        // Pages are newest-first; flatten and reverse into chronological order.
        const raws = pages
            .flat()
            .filter((raw) => raw.is_control !== false)
            .reverse();
        return { raws, truncated };
    }

    /**
     * Decrypt a poll's controls (for a one-shot consumer such as the export). Checks `shouldStop`
     * between messages as well as between pages, so a cancel is honoured promptly. Throws if the
     * fetch fails: the caller decides how to mark the result incomplete.
     */
    async fetchControls(
        chatId: string,
        pollId: string,
        shouldStop: () => boolean = () => false
    ): Promise<{ controls: PollControl[]; truncated: boolean }> {
        const { raws, truncated } = await this.fetchRaw(chatId, pollId, shouldStop);
        const controls: PollControl[] = [];
        for (const raw of raws) {
            if (shouldStop()) {
                break;
            }
            controls.push(toPollControl(await this.messages.decrypt(chatId, raw), raw));
        }
        return { controls, truncated };
    }

    /** A vote/close arrived over the socket for the open chat. */
    async ingest(chatId: string, raw: MessageResponse): Promise<void> {
        const pollId = raw.poll_message_id;
        if (!raw.is_control || !pollId || !isObjectId(pollId)) {
            return;
        }
        const decrypted = await this.messages.decrypt(chatId, raw);
        this.addControls(pollId, [toPollControl(decrypted, raw)]);
        if (decrypted.status === 'no_key') {
            this.trackUnresolved(chatId, pollId, [raw]);
        }
    }

    /** Our own vote/close, already recorded by `MessageService.sendControl`. */
    ingestSent(sent: MessageResponse, decrypted: DecryptedMessage): void {
        const pollId = sent.poll_message_id;
        if (!pollId || !isObjectId(pollId)) {
            return;
        }
        this.addControls(pollId, [toPollControl(decrypted, { ...sent, is_control: true })]);
    }

    /** The poll message was deleted: its votes are meaningless from now on. */
    forget(pollId: string): void {
        this.unresolved.delete(pollId);
        this.entries.update((map) => {
            const next = new Map(map);
            next.delete(pollId);
            return next;
        });
    }

    /** A single control message was deleted: take it out of whichever poll holds it. */
    removeControl(controlId: string): void {
        for (const [pollId, entry] of this.unresolved) {
            const raws = entry.raws.filter((raw) => raw._id !== controlId);
            if (raws.length === 0) {
                this.unresolved.delete(pollId);
            } else if (raws.length !== entry.raws.length) {
                this.unresolved.set(pollId, { ...entry, raws });
            }
        }

        this.entries.update((map) => {
            let next: Map<string, PollEntry> | null = null;
            for (const [pollId, entry] of map) {
                if (entry.controls.some((control) => control.id === controlId)) {
                    next ??= new Map(map);
                    next.set(pollId, { ...entry, controls: entry.controls.filter((c) => c.id !== controlId) });
                }
            }
            return next ?? map;
        });
    }

    clear(): void {
        this.entries.set(new Map());
        this.unresolved.clear();
        this.inflight.clear();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private addControls(pollId: string, incoming: PollControl[]): void {
        if (incoming.length === 0) {
            return;
        }
        this.entries.update((map) => {
            const current = map.get(pollId) ?? EMPTY;
            const byId = new Map(current.controls.map((control) => [control.id, control]));
            for (const control of incoming) {
                const known = byId.get(control.id);
                // Never let an unreadable re-read replace one we already opened.
                if (!known || control.trusted || !known.trusted) {
                    byId.set(control.id, control);
                }
            }
            const controls = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            return new Map(map).set(pollId, { ...current, controls });
        });
    }

    private patch(pollId: string, change: Partial<PollEntry>): void {
        this.entries.update((map) => new Map(map).set(pollId, { ...(map.get(pollId) ?? EMPTY), ...change }));
    }

    // ---------------------------------------------------------------------------------------
    // Votes that arrived before their sender's key
    // ---------------------------------------------------------------------------------------

    private trackUnresolved(chatId: string, pollId: string, raws: MessageResponse[]): void {
        if (raws.length === 0) {
            return;
        }
        const held = this.unresolved.get(pollId);
        this.unresolved.set(pollId, { chatId, raws: [...(held?.raws ?? []), ...raws] });
        this.scheduleRetry(0);
    }

    private scheduleRetry(attempt: number): void {
        if (attempt >= RETRY_DELAYS.length || this.unresolved.size === 0) {
            return;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null;
            try {
                // Each poll is retried against the chat it came from.
                const chats = new Set([...this.unresolved.values()].map((entry) => entry.chatId));
                for (const chatId of chats) {
                    await this.messages.refreshGrants(chatId);
                }
                for (const [pollId, entry] of [...this.unresolved]) {
                    const still: MessageResponse[] = [];
                    const opened: PollControl[] = [];
                    for (const raw of [...entry.raws].sort((a, b) => (a._id < b._id ? -1 : 1))) {
                        const decrypted = await this.messages.decrypt(entry.chatId, raw);
                        if (decrypted.status === 'no_key') {
                            still.push(raw);
                        } else {
                            opened.push(toPollControl(decrypted, raw));
                        }
                    }
                    this.addControls(pollId, opened);
                    if (still.length > 0) {
                        this.unresolved.set(pollId, { chatId: entry.chatId, raws: still });
                    } else {
                        this.unresolved.delete(pollId);
                    }
                }
            } catch {
                // Offline or transient; the next attempt covers it.
            }
            this.scheduleRetry(attempt + 1);
        }, RETRY_DELAYS[attempt]);
    }
}
