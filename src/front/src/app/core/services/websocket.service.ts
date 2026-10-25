import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { ConfigService } from './config.service';

export type WsEventType =
    | 'new_message'
    | 'message_edited'
    | 'message_deleted'
    | 'typing_start'
    | 'typing_stop'
    | 'message_read'
    | 'user_online'
    | 'user_offline'
    | 'chat_created'
    | 'chat_updated'
    | 'chat_deleted'
    | 'participants_added'
    | 'participants_removed'
    | 'key_epoch_started'
    | 'message_reaction_added'
    | 'message_reaction_removed'
    | 'message_pinned'
    | 'message_unpinned'
    | 'resync_required'
    | 'error';

export interface WsEnvelope {
    event_type: WsEventType;
    /** Position in this user's durable event stream, "<ms>-<seq>". Absent on non-durable events. */
    stream_id?: string;
    chat_id: string | null;
    user_id: string | null;
    payload: Record<string, unknown>;
}

const STREAM_ID = /^(\d{1,16})-(\d{1,16})$/;

/** True for a well-formed stream id. Anything else is never adopted as a cursor. */
export function isStreamId(value: unknown): value is string {
    return typeof value === 'string' && STREAM_ID.test(value);
}

/**
 * Order two stream ids as (ms, seq) number pairs. A string compare would put "10-0" before "9-1".
 * Negative when `a` is older than `b`.
 */
export function compareStreamIds(a: string, b: string): number {
    const [aMs, aSeq] = (STREAM_ID.exec(a) as RegExpExecArray).slice(1).map(BigInt);
    const [bMs, bSeq] = (STREAM_ID.exec(b) as RegExpExecArray).slice(1).map(BigInt);
    if (aMs !== bMs) {
        return aMs < bMs ? -1 : 1;
    }
    return aSeq === bSeq ? 0 : aSeq < bSeq ? -1 : 1;
}

/** Application close code meaning "authentication failed or expired". Reconnecting cannot help. */
export const SESSION_ENDED_CLOSE_CODE = 4401;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * The realtime channel.
 *
 * Broadcast only in one direction that matters: the backend rejects NEW_MESSAGE, MESSAGE_EDITED
 * and MESSAGE_DELETED over the socket and requires HTTP for them, so this service never sends
 * message mutations. Only typing and read receipts go outbound.
 *
 * Authentication is by cookie — the socket inherits the httpOnly access token, so there is no
 * token to pass in the URL. That also avoids the common mistake of putting a credential in a
 * query string, where it lands in proxy and server logs.
 */
@Injectable({ providedIn: 'root' })
export class WebSocketService {
    private readonly configService = inject(ConfigService);
    private readonly destroyRef = inject(DestroyRef);

    private socket: WebSocket | null = null;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closedByUs = false;

    private readonly events$ = new Subject<WsEnvelope>();
    private readonly reconnected$ = new Subject<void>();
    private readonly sessionEnded$ = new Subject<void>();

    /**
     * Highest durable `stream_id` seen this session. Memory only, and dropped by `disconnect()`
     * (logout, password reset, account deletion) so one account's position is never offered to
     * another's stream.
     */
    private cursor: string | null = null;
    private hasConnected = false;

    readonly isConnected = signal(false);

    constructor() {
        this.destroyRef.onDestroy(() => this.disconnect());
    }

    get messages() {
        return this.events$.asObservable();
    }

    /** Emits each time the socket re-opens after having been open before. */
    get reconnected() {
        return this.reconnected$.asObservable();
    }

    /**
     * The server closed the socket with 4401: our credentials are no longer valid. No reconnect is
     * scheduled; the session layer decides between a token refresh and ending the session.
     */
    get sessionEnded() {
        return this.sessionEnded$.asObservable();
    }

    /** The cursor that would be sent on the next reconnect. */
    get currentCursor(): string | null {
        return this.cursor;
    }

    /** Forget the stream position without touching the socket. */
    forgetCursor(): void {
        this.cursor = null;
        this.hasConnected = false;
    }

    connect(): void {
        if (
            this.socket &&
            (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        this.closedByUs = false;

        const configured = this.configService.wsUrl;
        // Resolve a relative path against the page origin so the dev server and the nginx
        // deployment can share one config value.
        const base = configured.startsWith('ws')
            ? configured
            : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${configured}`;
        // Replay is requested only on a reconnect: the first connection of a session has no
        // position to resume from, and no cursor means no replay.
        const url =
            this.hasConnected && this.cursor
                ? `${base}${base.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(this.cursor)}`
                : base;

        const socket = new WebSocket(url);
        this.socket = socket;

        socket.onopen = () => {
            this.reconnectAttempt = 0;
            this.isConnected.set(true);
            if (this.hasConnected) {
                this.reconnected$.next();
            }
            this.hasConnected = true;
        };

        socket.onmessage = (event: MessageEvent<string>) => {
            let envelope: WsEnvelope;
            try {
                envelope = JSON.parse(event.data) as WsEnvelope;
            } catch {
                // A frame we cannot parse is not worth tearing the connection down for.
                return;
            }
            this.accept(envelope);
        };

        socket.onclose = (event?: CloseEvent) => {
            this.isConnected.set(false);
            this.socket = null;

            if (event?.code === SESSION_ENDED_CLOSE_CODE && !this.closedByUs) {
                this.forgetCursor();
                this.sessionEnded$.next();
                return;
            }

            if (!this.closedByUs) {
                this.scheduleReconnect();
            }
        };

        socket.onerror = () => socket.close();
    }

    /**
     * Track the stream position and hand a well-formed event on. A frame that is not an object with
     * a string `event_type` is dropped before it can move the cursor: skipping past an event we did
     * not understand would lose it for good.
     */
    private accept(envelope: WsEnvelope): void {
        if (!envelope || typeof envelope !== 'object' || typeof envelope.event_type !== 'string') {
            return;
        }

        if (envelope.event_type === 'resync_required') {
            // The server could not replay from our cursor and says where to resume instead. A
            // missing or malformed value clears ours: keeping a position the server just
            // disowned would only provoke the same answer.
            const next = (envelope.payload as { cursor?: unknown } | undefined)?.cursor;
            this.cursor = isStreamId(next) ? next : null;
        } else if (
            isStreamId(envelope.stream_id) &&
            (!this.cursor || compareStreamIds(envelope.stream_id, this.cursor) > 0)
        ) {
            this.cursor = envelope.stream_id;
        }

        this.events$.next(envelope);
    }

    /**
     * Exponential backoff with jitter.
     *
     * Jitter matters here: without it every client disconnected by one backend restart reconnects
     * in lockstep and the stampede knocks it over again.
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            return;
        }

        const backoff = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
        const delay = backoff / 2 + Math.random() * (backoff / 2);
        this.reconnectAttempt += 1;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private send(envelope: Partial<WsEnvelope>): void {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(envelope));
        }
    }

    sendTyping(chatId: string, typing: boolean): void {
        this.send({ event_type: typing ? 'typing_start' : 'typing_stop', chat_id: chatId, payload: {} });
    }

    sendRead(chatId: string, lastReadMessageId: string): void {
        this.send({
            event_type: 'message_read',
            chat_id: chatId,
            payload: { last_read_message_id: lastReadMessageId },
        });
    }

    disconnect(): void {
        this.closedByUs = true;
        this.forgetCursor();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.socket?.close();
        this.socket = null;
        this.isConnected.set(false);
    }
}
