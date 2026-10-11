import { TestBed } from '@angular/core/testing';

import { VoiceRecorderService } from './voice-recorder.service';

class FakeTrack {
    stopped = false;
    stop(): void {
        this.stopped = true;
    }
}

class FakeMediaRecorder {
    static isTypeSupported(type: string): boolean {
        return type === 'audio/webm;codecs=opus';
    }

    /** Overridable per-test to simulate `start()` throwing synchronously. */
    static startShouldThrow = false;
    /** Reset per-test; counts how many recorders were actually constructed. */
    static constructedCount = 0;

    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    readonly mimeType: string;
    private readonly listeners = new Map<string, Array<() => void>>();

    constructor(
        public readonly stream: MediaStream,
        options?: { mimeType?: string }
    ) {
        this.mimeType = options?.mimeType ?? 'audio/webm';
        FakeMediaRecorder.constructedCount++;
    }

    start(): void {
        if (FakeMediaRecorder.startShouldThrow) {
            throw new DOMException('Recorder is in an invalid state.', 'InvalidStateError');
        }
    }

    stop(): void {
        this.ondataavailable?.({ data: new Blob(['chunk'], { type: this.mimeType }) });
        for (const listener of this.listeners.get('stop') ?? []) {
            listener();
        }
    }

    addEventListener(event: string, listener: () => void): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
}

describe('VoiceRecorderService', () => {
    let service: VoiceRecorderService;
    let originalMediaRecorder: typeof MediaRecorder;
    let getUserMediaSpy: jasmine.Spy;
    let fakeTracks: FakeTrack[];

    function fakeStream(): MediaStream {
        fakeTracks = [new FakeTrack(), new FakeTrack()];
        return { getTracks: () => fakeTracks } as unknown as MediaStream;
    }

    beforeEach(() => {
        TestBed.configureTestingModule({});
        service = TestBed.inject(VoiceRecorderService);

        originalMediaRecorder = window.MediaRecorder;
        (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;

        if (!navigator.mediaDevices) {
            (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {};
        }
        getUserMediaSpy = spyOn(navigator.mediaDevices, 'getUserMedia').and.resolveTo(fakeStream());

        FakeMediaRecorder.startShouldThrow = false;
        FakeMediaRecorder.constructedCount = 0;
    });

    afterEach(() => {
        (window as unknown as { MediaRecorder: unknown }).MediaRecorder = originalMediaRecorder;
        FakeMediaRecorder.startShouldThrow = false;
    });

    it('starts idle', () => {
        expect(service.recordingState()).toBe('idle');
        expect(service.permission()).toBe('idle');
    });

    it('transitions idle -> recording -> stopped across start/stop, and reports granted permission', async () => {
        await service.start();
        expect(service.recordingState()).toBe('recording');
        expect(service.permission()).toBe('granted');

        const result = await service.stop();
        expect(service.recordingState()).toBe('stopped');
        expect(result.blob.size).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('releases the mic tracks once stopped', async () => {
        await service.start();
        await service.stop();
        expect(fakeTracks.every((track) => track.stopped)).toBeTrue();
    });

    it('sets permission to denied when getUserMedia rejects with NotAllowedError', async () => {
        getUserMediaSpy.and.rejectWith({ name: 'NotAllowedError' });

        await expectAsync(service.start()).toBeRejected();
        expect(service.permission()).toBe('denied');
        expect(service.recordingState()).toBe('idle');
    });

    it('sets permission to unavailable when no microphone is present', async () => {
        getUserMediaSpy.and.rejectWith({ name: 'NotFoundError' });

        await expectAsync(service.start()).toBeRejected();
        expect(service.permission()).toBe('unavailable');
    });

    it('cancel discards the recording and releases the mic without resolving a sendable result', async () => {
        await service.start();
        service.cancel();

        expect(service.recordingState()).toBe('idle');
        expect(fakeTracks.every((track) => track.stopped)).toBeTrue();
    });

    it('forceRelease stops an in-progress recording and releases the mic', async () => {
        await service.start();
        service.forceRelease();

        expect(service.recordingState()).toBe('idle');
        expect(fakeTracks.every((track) => track.stopped)).toBeTrue();
    });

    it('forceRelease is a no-op when nothing is recording', () => {
        expect(() => service.forceRelease()).not.toThrow();
        expect(service.recordingState()).toBe('idle');
    });

    it('double-tapping start() before the first call resolves only acquires one stream/recorder', async () => {
        const acquiredStreams: MediaStream[] = [];
        getUserMediaSpy.and.callFake(() => {
            const stream = fakeStream();
            acquiredStreams.push(stream);
            return Promise.resolve(stream);
        });

        // Neither call is awaited individually — this is the double-click/rapid-second-tap shape:
        // the second call's synchronous guard must see the first call is already in flight, even
        // though `recordingState` has not yet flipped to `'recording'`.
        const first = service.start();
        const second = service.start();
        await Promise.all([first, second]);

        expect(getUserMediaSpy).toHaveBeenCalledTimes(1);
        expect(FakeMediaRecorder.constructedCount).toBe(1);
        expect(acquiredStreams.length).toBe(1);
        expect(service.recordingState()).toBe('recording');

        // Stopping afterward must release exactly the one real stream, not leak a second.
        await service.stop();
        expect(acquiredStreams[0].getTracks().every((track) => (track as unknown as FakeTrack).stopped)).toBeTrue();
    });

    it('releases the stream instead of leaking it when MediaRecorder.start() throws synchronously', async () => {
        FakeMediaRecorder.startShouldThrow = true;

        await expectAsync(service.start()).toBeRejected();

        expect(service.recordingState()).toBe('idle');
        expect(fakeTracks.every((track) => track.stopped)).toBeTrue();

        // A retry afterward must succeed cleanly rather than compounding the leak.
        FakeMediaRecorder.startShouldThrow = false;
        await service.start();
        expect(service.recordingState()).toBe('recording');
    });
});
