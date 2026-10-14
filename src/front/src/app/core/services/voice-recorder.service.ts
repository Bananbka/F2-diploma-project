import { DestroyRef, inject, Injectable, signal } from '@angular/core';

/**
 * Microphone permission, as last observed. `'idle'` means never asked; `'unavailable'` covers both
 * "no microphone found" and "the API does not exist here" (e.g. a non-secure context) — the
 * composer shows the same inline message either way, so the distinction is not surfaced further.
 */
export type MicPermissionState = 'idle' | 'granted' | 'denied' | 'unavailable';

export type RecordingState = 'idle' | 'recording' | 'stopped';

/**
 * Tried in order via `MediaRecorder.isTypeSupported`. Opus-in-WebM is what Chromium and Firefox
 * both record natively; Ogg and the bare container follow for older engines, and the empty string
 * at the end means "let the browser pick" rather than fail outright.
 */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];

/** How often the amplitude meter samples the live stream while recording. */
const METER_FFT_SIZE = 256;

export interface RecordingResult {
    blob: Blob;
    durationMs: number;
}

/**
 * Records a voice note from the microphone and reports a live amplitude while doing so.
 *
 * Deliberately framework-free below the Angular surface — this is a thin wrapper over
 * `MediaRecorder` and the Web Audio API, no third-party audio library. The amplitude meter is a
 * nice-to-have cue for the recording UI, not something the sent attachment depends on, so any
 * failure to stand it up (an unsupported browser, a stream that is not a real `MediaStream` in a
 * test) is swallowed rather than failing the recording itself.
 */
@Injectable({ providedIn: 'root' })
export class VoiceRecorderService {
    private readonly destroyRef = inject(DestroyRef);

    readonly permission = signal<MicPermissionState>('idle');
    readonly recordingState = signal<RecordingState>('idle');
    /** Roughly 0..1, read from the live stream's RMS amplitude while recording; 0 once stopped. */
    readonly currentAmplitude = signal(0);

    private stream: MediaStream | null = null;
    private recorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private mimeType = '';
    private startedAt = 0;

    private audioContext: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private meterFrame: number | null = null;

    /**
     * Set synchronously, before the first `await` in `start()`. `recordingState` only flips to
     * `'recording'` once `getUserMedia` resolves, so relying on it alone to guard re-entrancy lets
     * two rapid taps both pass the check and both acquire a stream/recorder/context — whichever
     * resolves second overwrites the fields, leaking the first set with no way to release them.
     */
    private starting = false;

    constructor() {
        // A component using this service can be torn down mid-recording (e.g. the chat is
        // switched) without ever calling `stop()`/`cancel()`. Release the mic regardless.
        this.destroyRef.onDestroy(() => this.forceRelease());
    }

    /** Request the mic and start recording. Rejects (and updates `permission`) without starting anything. */
    async start(): Promise<void> {
        if (this.recordingState() === 'recording' || this.starting) {
            return;
        }
        this.starting = true;

        try {
            if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
                this.permission.set('unavailable');
                throw new Error('Voice recording is not available in this browser.');
            }

            let stream: MediaStream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                const name = (error as { name?: string } | undefined)?.name;
                if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
                    this.permission.set('denied');
                } else {
                    // NotFoundError/DevicesNotFoundError (no mic present) and anything else land
                    // here — there is nothing more specific the UI can say about them.
                    this.permission.set('unavailable');
                }
                throw error;
            }

            this.permission.set('granted');
            this.mimeType = this.pickMimeType();
            this.chunks = [];

            // From here on, any throw must release the stream/recorder/context it already set up —
            // otherwise a caller that retries after a failure leaks a second one on top.
            try {
                const recorder = this.mimeType
                    ? new MediaRecorder(stream, { mimeType: this.mimeType })
                    : new MediaRecorder(stream);
                recorder.ondataavailable = (event: BlobEvent) => {
                    if (event.data.size > 0) {
                        this.chunks.push(event.data);
                    }
                };

                this.stream = stream;
                this.recorder = recorder;
                this.startMeter(stream);

                recorder.start();
                this.startedAt = performance.now();
                this.recordingState.set('recording');
            } catch (error) {
                this.recorder = null;
                this.chunks = [];
                this.stopMeter();
                stream.getTracks().forEach((track) => track.stop());
                this.stream = null;
                this.recordingState.set('idle');
                throw error;
            }
        } finally {
            this.starting = false;
        }
    }

    /** Stop recording and resolve the recorded bytes. Releases the mic before resolving. */
    async stop(): Promise<RecordingResult> {
        const recorder = this.recorder;
        if (!recorder || this.recordingState() !== 'recording') {
            throw new Error('Not recording.');
        }

        const durationMs = performance.now() - this.startedAt;

        const stopped = new Promise<void>((resolve) => {
            recorder.addEventListener('stop', () => resolve(), { once: true });
        });
        recorder.stop();
        await stopped;

        this.stopMeter();
        this.releaseStream();

        const blob = new Blob(this.chunks, { type: this.mimeType || recorder.mimeType || 'audio/webm' });
        this.chunks = [];
        this.recorder = null;
        this.recordingState.set('stopped');

        return { blob, durationMs };
    }

    /** Discard the in-progress recording and release the mic. No result is produced. */
    cancel(): void {
        if (this.recorder && this.recordingState() === 'recording') {
            try {
                this.recorder.stop();
            } catch {
                // Already stopped/inactive — nothing left to discard.
            }
        }
        this.recorder = null;
        this.chunks = [];
        this.stopMeter();
        this.releaseStream();
        this.recordingState.set('idle');
    }

    /** For a caller tearing down outside the normal stop/cancel flow — always safe to call. */
    forceRelease(): void {
        if (this.recordingState() === 'recording') {
            this.cancel();
            return;
        }
        this.stopMeter();
        this.releaseStream();
    }

    private releaseStream(): void {
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
    }

    private pickMimeType(): string {
        if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
            return '';
        }
        for (const candidate of MIME_CANDIDATES) {
            if (MediaRecorder.isTypeSupported(candidate)) {
                return candidate;
            }
        }
        return '';
    }

    private startMeter(stream: MediaStream): void {
        const AudioContextCtor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
            return;
        }

        // Created outside the try block and explicitly closed on failure below — an `AudioContext`
        // left open because `createMediaStreamSource` rejected a non-real stream (every test's
        // fake `MediaStream` included) is a real OS-level audio resource, and leaving a handful
        // open across a test run was observed to make every *subsequent* `AudioContext`
        // construction progressively slower.
        const audioContext = new AudioContextCtor();
        try {
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = METER_FFT_SIZE;
            source.connect(analyser);

            this.audioContext = audioContext;
            this.analyser = analyser;

            const data = new Uint8Array(analyser.frequencyBinCount);
            const poll = (): void => {
                if (!this.analyser) {
                    return;
                }
                this.analyser.getByteTimeDomainData(data);

                let sumSquares = 0;
                for (const value of data) {
                    const normalized = (value - 128) / 128;
                    sumSquares += normalized * normalized;
                }
                const rms = Math.sqrt(sumSquares / data.length);
                // RMS of a normal speaking voice sits well under 1, so scale it up for a visible cue.
                this.currentAmplitude.set(Math.min(1, rms * 4));

                this.meterFrame = requestAnimationFrame(poll);
            };
            this.meterFrame = requestAnimationFrame(poll);
        } catch {
            // The amplitude meter is cosmetic. A stream that cannot be wired into Web Audio (an
            // unsupported browser, or a fake stream in a test) should not block recording itself.
            void audioContext.close().catch(() => undefined);
        }
    }

    private stopMeter(): void {
        if (this.meterFrame !== null) {
            cancelAnimationFrame(this.meterFrame);
            this.meterFrame = null;
        }
        this.analyser = null;
        if (this.audioContext) {
            void this.audioContext.close().catch(() => undefined);
            this.audioContext = null;
        }
        this.currentAmplitude.set(0);
    }
}
