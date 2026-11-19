import { inject, Injectable, signal } from '@angular/core';

import { bindStorageKey } from './storage-sync';
import { pairKey } from './trust-keys';
import { TrustState, TrustStoreService } from './trust-store.service';

/**
 * Where an observed number came from.
 *
 * `roster` — derived from the keys the send path is about to wrap to (`publishSenderChain`), or
 * carried by the `KeyChangedError` that path threw. This is the number that decides whether a
 * chain key goes out, so it is the one a block is about.
 *
 * `lookup` — derived from `POST /crypto/keys/batch` (the safety-number screen, the encryption panel,
 * distribution ingest). A server that equivocates can answer a lookup with the old keys while the
 * roster carries new ones, so a lookup may raise an alarm but never clear one a roster raised.
 */
export type ObservationSource = 'roster' | 'lookup';

interface Observation {
    number: string;
    source: ObservationSource;
}

/** `<chat id>|<own user id>:<peer user id>` -> the refusal, persisted. */
const REFUSALS_KEY = 'ns.refusals';

/** The numbers a refused send in one chat was refused on, for one pair. */
export interface Refusal {
    current: string;
    previous: string;
    /** The refusal also found a key under our own id not ours at unlock (wording, not blocking). */
    ownDevicesChanged: boolean;
    /**
     * `TrustStoreService.recordStamp` when the refusal was recorded. A different stamp now means the
     * user has confirmed some number since, so this refusal no longer says anything current: the
     * next roster check decides afresh (and re-refuses if the roster still differs).
     */
    recordedAgainst: string | null;
}

/**
 * What this client currently knows about *key changes*, as opposed to what the user confirmed.
 *
 * `TrustStoreService` holds the confirmations (persisted, shared across tabs). This service holds
 * the two facts derived against them: the safety numbers the key material presented this session
 * derives to (observations), and the chats where a send was refused because one of those numbers
 * differed (refusals). Every "key changed" state the UI blocks on is computed here, from both.
 */
@Injectable({ providedIn: 'root' })
export class KeyChangeStateService {
    private readonly trust = inject(TrustStoreService);

    /**
     * The most recent safety number this session *derived* for each pair, from key material whose
     * binding signatures were verified — written by `KeyStoreService` whenever it wraps to a roster,
     * ingests a peer's distribution, or computes a number for the safety-number screen.
     *
     * Memory only, on purpose: a current number is a fact about the keys the server is presenting
     * right now, re-derived on every contact, and persisting it would let a stale observation
     * outlive the keys it described.
     */
    private readonly observed = signal<Record<string, Observation>>({});

    /**
     * Per chat and pair, the number a send in *that chat* was refused on (`KeyChangedError`).
     *
     * Observations are per pair, so a second chat's honest roster for the same peer used to replace
     * the first chat's changed one — the first chat's block then had no number to show, and the
     * safety-number screen read "verified, unchanged" while that chat stayed refused. A refusal is
     * per chat, outlives other chats' observations, and lapses only when the user confirms *that*
     * number (or the chat's own roster check later finds the peer verified). Clearing the
     * verification does not lift it: that would let the next publish in the refused chat pass the
     * very keys it refused, on trust-on-first-use — so `TrustStoreService.forget` is refused while one
     * is outstanding.
     *
     * Persisted (`ns.refusals`) and synced across tabs, unlike observations: a reload or a second tab
     * must not forget that a chat was refused, or "Clear verification" there would reopen the same
     * trust-on-first-use hole. The contents are public safety numbers. Like trust records they are
     * kept per account of ours and not wiped on logout. Re-read on the `storage` event only.
     */
    private readonly refusals = signal<Record<string, Refusal>>(readRefusals() ?? {});

    /**
     * Refusals this tab holds that storage does not, because the last write failed. Memory is
     * authoritative for these: adopting another tab's stored copy must not drop them, or a refusal
     * would lapse here without the user confirming anything.
     */
    private unpersisted: Record<string, Refusal> = {};

    constructor() {
        this.trust.setForgetGuard((selfId, peerId) => this.hasPendingRefusal(selfId, peerId));
        bindStorageKey(REFUSALS_KEY, (event) => this.adoptStored(event));
        // Nothing else ever deletes a lapsed refusal, so without this `ns.refusals` only grows.
        this.pruneLapsed();
    }

    /**
     * Note the number the peer's keys currently derive to. Does not change what is verified: it
     * only gives `observedState` / `changedAmong` something to compare the record against.
     *
     * A `lookup` observation never replaces a `roster` one that currently reads as changed. That is
     * the equivocation case: the roster the send path checked carried a new key, while a batch
     * lookup (the safety-number screen) was answered with the old one. Letting the lookup win would
     * clear the banner and show "verified, unchanged" while the next send blocks again.
     */
    observe(selfId: string, peerId: string, currentSafetyNumber: string, source: ObservationSource = 'roster'): void {
        const key = pairKey(selfId, peerId);
        if (!key) {
            return;
        }
        const existing = this.observed()[key];
        if (existing && existing.number === currentSafetyNumber && existing.source === source) {
            return;
        }
        const existingChanged =
            existing?.source === 'roster' && this.trust.stateFor(selfId, peerId, existing.number).kind === 'changed';
        if (source === 'lookup' && existingChanged) {
            return;
        }
        // Nor does another chat's unchanged roster replace a changed one while any chat still holds
        // a refusal for this pair: the pair is not "fine" just because one chat's roster is.
        if (
            existingChanged &&
            this.trust.stateFor(selfId, peerId, currentSafetyNumber).kind !== 'changed' &&
            this.hasPendingRefusal(selfId, peerId)
        ) {
            return;
        }
        this.observed.update((all) => ({ ...all, [key]: { number: currentSafetyNumber, source } }));
    }

    /**
     * The trust state against the last number observed for this pair, or null when nothing has
     * been derived for it this session. Reactive: tracks both the observation and the record, so a
     * `markVerified` of the new number flips a `changed` result back to `verified` at once.
     */
    observedState(selfId: string, peerId: string): TrustState | null {
        const key = pairKey(selfId, peerId);
        const current = key ? this.observed()[key] : undefined;
        return current === undefined ? null : this.trust.stateFor(selfId, peerId, current.number);
    }

    /**
     * The number the send path is currently blocked on for this pair: the refused chat's own number
     * when `chatId` holds a refusal, else a roster-derived observation that differs from the
     * confirmed record, or null. The safety-number screen shows this instead of its own lookup when
     * present, so the number the user compares is the one whose acceptance unblocks sending. Reactive.
     */
    blockingNumber(selfId: string, peerId: string, chatId?: string): string | null {
        const refusal = chatId ? this.refusalFor(chatId, selfId, peerId) : null;
        if (refusal) {
            return refusal.current;
        }
        const key = pairKey(selfId, peerId);
        const current = key ? this.observed()[key] : undefined;
        if (!current || current.source !== 'roster') {
            return null;
        }
        return this.trust.stateFor(selfId, peerId, current.number).kind === 'changed' ? current.number : null;
    }

    /** Those of `peerIds` whose last observed number differs from the one the user verified. Reactive. */
    changedAmong(selfId: string, peerIds: readonly string[]): string[] {
        return peerIds.filter((peerId) => this.observedState(selfId, peerId)?.kind === 'changed');
    }

    /** Note that a send in `chatId` was refused because this pair's number changed. */
    recordRefusal(
        chatId: string,
        selfId: string,
        peerId: string,
        current: string,
        previous: string,
        ownDevicesChanged = false
    ): void {
        const key = pairKey(selfId, peerId);
        if (!key || !chatId) {
            return;
        }
        const id = `${chatId}|${key}`;
        const existing = this.refusals()[id];
        const recordedAgainst = this.trust.recordStamp(selfId, peerId);
        if (
            existing &&
            existing.current === current &&
            existing.previous === previous &&
            existing.ownDevicesChanged === ownDevicesChanged &&
            existing.recordedAgainst === recordedAgainst
        ) {
            return;
        }
        this.writeRefusals({
            ...this.latestRefusals(),
            [id]: { current, previous, ownDevicesChanged, recordedAgainst },
        });
    }

    /** Peers with an outstanding refusal in this chat. Independent of any participant list. Reactive. */
    refusedPeers(chatId: string, selfId: string): string[] {
        const prefix = `${chatId}|${selfId}:`;
        if (!chatId || !selfId) {
            return [];
        }
        return Object.keys(this.refusals())
            .filter((id) => id.startsWith(prefix))
            .map((id) => id.slice(prefix.length))
            .filter((peerId) => this.refusalFor(chatId, selfId, peerId) !== null);
    }

    /** Whether an outstanding refusal in this chat attributed the change to our own devices. Reactive. */
    ownDevicesChangedIn(chatId: string, selfId: string): boolean {
        return this.refusedPeers(chatId, selfId).some(
            (peerId) => this.refusalFor(chatId, selfId, peerId)?.ownDevicesChanged === true
        );
    }

    /**
     * Forget this session's observations (logout). They describe keys a signed-out account was
     * shown and mean nothing to the next one. Refusals are not touched here; see `refusals`.
     */
    clearSession(): void {
        this.observed.set({});
    }

    /**
     * The outstanding refusal for this pair in this chat, or null. Outstanding until the user
     * confirms a number: the refused one lifts it outright; any other one supersedes it (the record
     * is newer than the refusal), and the chat's next roster check decides again. Clearing the
     * verification is refused while one is outstanding (`TrustStoreService.forget`). Reactive.
     */
    refusalFor(chatId: string, selfId: string, peerId: string): Refusal | null {
        const key = pairKey(selfId, peerId);
        const refusal = key && chatId ? this.refusals()[`${chatId}|${key}`] : undefined;
        return refusal && !this.lapsed(selfId, peerId, refusal) ? refusal : null;
    }

    /**
     * Whether the user has confirmed a number since this refusal was recorded: the refused number
     * itself, or any other (the record's stamp moved). Either way the refusal no longer blocks.
     */
    private lapsed(selfId: string, peerId: string, refusal: Refusal): boolean {
        if (this.trust.stateFor(selfId, peerId, refusal.current).kind === 'verified') {
            return true;
        }
        const stamp = this.trust.recordStamp(selfId, peerId);
        return stamp !== null && stamp !== refusal.recordedAgainst;
    }

    /** The chat's own roster check found this pair acceptable again: its refusal is over. */
    clearRefusal(chatId: string, selfId: string, peerId: string): void {
        const key = pairKey(selfId, peerId);
        const id = `${chatId}|${key}`;
        if (!key || !(id in this.refusals())) {
            return;
        }
        delete this.unpersisted[id];
        const next = { ...this.latestRefusals() };
        delete next[id];
        this.writeRefusals(next);
    }

    /** Whether any chat holds an outstanding refusal for this pair. */
    hasPendingRefusal(selfId: string, peerId: string): boolean {
        const suffix = `|${pairKey(selfId, peerId)}`;
        return Object.keys(this.refusals()).some(
            (id) => id.endsWith(suffix) && this.refusalFor(id.slice(0, id.indexOf('|')), selfId, peerId) !== null
        );
    }

    /**
     * Storage first, so a refusal another tab wrote a moment ago is not overwritten by our copy —
     * plus whatever this tab could not persist, which storage cannot know about.
     */
    private latestRefusals(): Record<string, Refusal> {
        const stored = readRefusals();
        return stored === null ? this.refusals() : { ...stored, ...this.unpersisted };
    }

    /**
     * Write the refusals, dropping any that have lapsed: `refusalFor` already ignores them, so
     * keeping them would only let `ns.refusals` grow without bound.
     */
    private writeRefusals(next: Record<string, Refusal>): void {
        const live = this.withoutLapsed(next);
        this.refusals.set(live);
        try {
            localStorage.setItem(REFUSALS_KEY, JSON.stringify(live));
            this.unpersisted = {};
        } catch {
            // Held in memory for this tab: it still blocks here, just not after a reload — and a
            // later storage event from another tab must not drop it (`adoptStored`).
            this.unpersisted = { ...live };
        }
    }

    /** Remove lapsed refusals from memory and storage, if there are any. */
    private pruneLapsed(): void {
        // Lapsing is judged against the confirmed records, which another tab may have changed since
        // this one read them; a stale record could make a fresh refusal look lapsed.
        this.trust.refresh();
        const current = this.latestRefusals();
        if (Object.keys(this.withoutLapsed(current)).length !== Object.keys(current).length) {
            this.writeRefusals(current);
        }
    }

    private withoutLapsed(all: Record<string, Refusal>): Record<string, Refusal> {
        const live: Record<string, Refusal> = {};
        for (const [id, refusal] of Object.entries(all)) {
            const pair = parseRefusalId(id);
            // An id that does not parse cannot be judged; keep it rather than guess (fail closed).
            if (!pair || !this.lapsed(pair.selfId, pair.peerId, refusal)) {
                live[id] = refusal;
            }
        }
        return live;
    }

    /**
     * Adopt other tabs' refusals. Refusals fail closed, so this merges rather than replaces:
     *
     * - another tab rewrote `ns.refusals` (read-merge-write, so its copy already holds every
     *   refusal storage held) — take it, plus whatever this tab could not persist;
     * - storage was cleared or the key removed (`localStorage.clear()` elsewhere, `newValue` null) —
     *   that says nothing about whether any chat was refused, so keep everything this tab holds and
     *   write it back, so that a reload here still remembers it.
     */
    private adoptStored(event: StorageEvent): void {
        if (event.key === null || event.newValue === null) {
            this.writeRefusals({ ...(readRefusals() ?? {}), ...this.refusals() });
            return;
        }
        const stored = readRefusals();
        if (stored !== null) {
            this.refusals.set({ ...stored, ...this.unpersisted });
        }
    }
}

/** `<chat id>|<own user id>:<peer user id>` back into its pair, or null when it does not parse. */
function parseRefusalId(id: string): { selfId: string; peerId: string } | null {
    const bar = id.indexOf('|');
    const pair = bar < 0 ? '' : id.slice(bar + 1);
    const colon = pair.indexOf(':');
    if (bar <= 0 || colon <= 0 || colon === pair.length - 1) {
        return null;
    }
    return { selfId: pair.slice(0, colon), peerId: pair.slice(colon + 1) };
}

/**
 * The stored refusals, or null when storage cannot be read. Malformed entries are dropped; a
 * dropped refusal fails open only as far as a missing record does — the next roster check still
 * compares against the confirmed number and refuses again if it differs.
 */
function readRefusals(): Record<string, Refusal> | null {
    let raw: string | null;
    try {
        raw = localStorage.getItem(REFUSALS_KEY);
    } catch {
        return null;
    }
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return {};
        }
        const valid: Record<string, Refusal> = {};
        for (const [id, value] of Object.entries(parsed)) {
            const r = value as Partial<Refusal> | null;
            if (
                r &&
                typeof r.current === 'string' &&
                typeof r.previous === 'string' &&
                (typeof r.recordedAgainst === 'string' || r.recordedAgainst === null)
            ) {
                valid[id] = {
                    current: r.current,
                    previous: r.previous,
                    ownDevicesChanged: r.ownDevicesChanged === true,
                    recordedAgainst: r.recordedAgainst,
                };
            }
        }
        return valid;
    } catch {
        return {};
    }
}
