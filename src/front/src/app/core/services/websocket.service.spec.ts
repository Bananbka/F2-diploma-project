import { TestBed } from '@angular/core/testing';

import { ConfigService } from './config.service';
import { compareStreamIds, isStreamId, WebSocketService, WsEnvelope } from './websocket.service';

class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeSocket[] = [];

    readyState = FakeSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event?: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
        FakeSocket.instances.push(this);
    }

    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }

    receive(frame: unknown): void {
        this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
    }

    /** A drop from the network, not a close we asked for. */
    drop(): void {
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.();
    }

    close(): void {
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.();
    }

    send(): void {
        // outbound frames are not under test
    }
}

describe('stream ids', () => {
    it('orders numerically, not as strings', () => {
        expect('10-0' < '9-1')
            .withContext('string order is the trap')
            .toBeTrue();
        expect(compareStreamIds('10-0', '9-1')).toBeGreaterThan(0);
        expect(compareStreamIds('9-1', '9-2')).toBeLessThan(0);
        expect(compareStreamIds('9-1', '9-1')).toBe(0);
    });

    it('accepts only <ms>-<seq>', () => {
        expect(isStreamId('1700000000000-3')).toBeTrue();
        for (const bad of ['', '5', '5-', '-5', 'a-b', '5-5-5', '5 -1', null, 12, undefined]) {
            expect(isStreamId(bad)).withContext(String(bad)).toBeFalse();
        }
    });
});

describe('WebSocketService event stream', () => {
    let service: WebSocketService;
    let original: typeof WebSocket;
    let seen: WsEnvelope[];
    let reconnects: number;

    const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

    beforeEach(() => {
        jasmine.clock().install();
        original = window.WebSocket;
        FakeSocket.instances = [];
        (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

        TestBed.configureTestingModule({
            providers: [{ provide: ConfigService, useValue: { wsUrl: 'ws://test/ws' } }],
        });
        service = TestBed.inject(WebSocketService);
        seen = [];
        reconnects = 0;
        service.messages.subscribe((e) => seen.push(e));
        service.reconnected.subscribe(() => (reconnects += 1));
    });

    afterEach(() => {
        service.disconnect();
        (window as unknown as { WebSocket: unknown }).WebSocket = original;
        jasmine.clock().uninstall();
    });

    /** Connect, then lose the connection and let the backoff timer fire the next attempt. */
    function dropAndReconnect(): void {
        last().drop();
        jasmine.clock().tick(31_000);
    }

    it('connects without a cursor the first time', () => {
        service.connect();
        expect(last().url).toBe('ws://test/ws');
    });

    it('appends the highest stream_id as cursor on reconnect', () => {
        service.connect();
        last().open();
        last().receive({ event_type: 'new_message', stream_id: '100-0', payload: {} });
        last().receive({ event_type: 'new_message', stream_id: '100-1', payload: {} });

        dropAndReconnect();

        expect(FakeSocket.instances.length).toBe(2);
        expect(last().url).toBe('ws://test/ws?cursor=100-1');
        last().open();
        expect(reconnects).toBe(1);
    });

    it('compares ids numerically: 10-0 is newer than 9-1', () => {
        service.connect();
        last().open();
        last().receive({ event_type: 'new_message', stream_id: '9-1', payload: {} });
        last().receive({ event_type: 'new_message', stream_id: '10-0', payload: {} });
        last().receive({ event_type: 'new_message', stream_id: '9-5', payload: {} });

        expect(service.currentCursor).toBe('10-0');
    });

    it('ignores events without a stream_id, such as typing', () => {
        service.connect();
        last().open();
        last().receive({ event_type: 'typing_start', payload: {} });
        expect(service.currentCursor).toBeNull();
    });

    it('does not advance the cursor from a malformed frame or a bad id', () => {
        service.connect();
        last().open();
        last().receive({ event_type: 'new_message', stream_id: '5-0', payload: {} });

        last().receive('{not json');
        last().receive({ stream_id: '99-0', payload: {} }); // no event_type
        last().receive({ event_type: 'new_message', stream_id: 'bogus', payload: {} });
        last().receive({ event_type: 'new_message', stream_id: '99-0; drop', payload: {} });

        expect(service.currentCursor).toBe('5-0');
        // Unparseable and typeless frames are dropped; a live event with a bad id is still delivered,
        // it just cannot move the cursor.
        expect(seen.length).toBe(3);
    });

    it('adopts the cursor from resync_required, and clears it when null', () => {
        service.connect();
        last().open();
        last().receive({ event_type: 'new_message', stream_id: '5-0', payload: {} });

        last().receive({ event_type: 'resync_required', payload: { reason: 'cursor_too_old', cursor: '80-2' } });
        expect(service.currentCursor).toBe('80-2');
        expect(seen[seen.length - 1].event_type).toBe('resync_required');

        last().receive({ event_type: 'resync_required', payload: { reason: 'stream_gap', cursor: null } });
        expect(service.currentCursor).toBeNull();

        dropAndReconnect();
        expect(last().url).toBe('ws://test/ws');
    });

    it('can move the cursor backwards only through resync_required', () => {
        service.connect();
        last().open();
        last().receive({ event_type: 'new_message', stream_id: '50-0', payload: {} });
        last().receive({ event_type: 'resync_required', payload: { reason: 'x', cursor: '20-0' } });
        expect(service.currentCursor).toBe('20-0');
    });

    it('clears the cursor on disconnect (logout, lock, account deletion)', () => {
        service.connect();
        last().open();
        last().receive({ event_type: 'new_message', stream_id: '5-0', payload: {} });

        service.disconnect();
        expect(service.currentCursor).toBeNull();

        service.connect();
        last().open();
        expect(last().url).toBe('ws://test/ws');
        expect(reconnects).withContext('a fresh session is not a reconnect').toBe(0);
    });

    it('treats close code 4401 as a session end: no reconnect, cursor dropped, listeners told', () => {
        let ended = 0;
        service.sessionEnded.subscribe(() => (ended += 1));
        service.connect();
        last().open();
        last().receive({ event_type: 'new_message', stream_id: '5-0', payload: {} });

        last().readyState = FakeSocket.CLOSED;
        last().onclose?.({ code: 4401 } as CloseEvent);
        jasmine.clock().tick(120_000);

        expect(ended).toBe(1);
        expect(FakeSocket.instances.length).withContext('no reconnect attempt').toBe(1);
        expect(service.currentCursor).toBeNull();
    });

    it('still reconnects after an ordinary abnormal close', () => {
        service.connect();
        last().open();
        last().readyState = FakeSocket.CLOSED;
        last().onclose?.({ code: 1006 } as CloseEvent);
        jasmine.clock().tick(31_000);
        expect(FakeSocket.instances.length).toBe(2);
    });

    it('does not send a cursor before the first successful connection', () => {
        service.connect();
        // Never opened: a failed first attempt must not replay on the strength of nothing.
        dropAndReconnect();
        expect(last().url).toBe('ws://test/ws');
    });
});
