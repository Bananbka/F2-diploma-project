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
    | 'key_epoch_started'
    | 'error';

export interface WsEnvelope {
    event_type: WsEventType;
    chat_id: string | null;
    user_id: string | null;
    payload: Record<string, unknown>;
}

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

    readonly isConnected = signal(false);

    constructor() {
        this.destroyRef.onDestroy(() => this.disconnect());
    }

    get messages() {
        return this.events$.asObservable();
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
        const url = configured.startsWith('ws')
            ? configured
            : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${configured}`;

        const socket = new WebSocket(url);
        this.socket = socket;

        socket.onopen = () => {
            this.reconnectAttempt = 0;
            this.isConnected.set(true);
        };

        socket.onmessage = (event: MessageEvent<string>) => {
            try {
                this.events$.next(JSON.parse(event.data) as WsEnvelope);
            } catch {
                // A frame we cannot parse is not worth tearing the connection down for.
            }
        };

        socket.onclose = () => {
            this.isConnected.set(false);
            this.socket = null;

            if (!this.closedByUs) {
                this.scheduleReconnect();
            }
        };

        socket.onerror = () => socket.close();
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

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.socket?.close();
        this.socket = null;
        this.isConnected.set(false);
    }
}
