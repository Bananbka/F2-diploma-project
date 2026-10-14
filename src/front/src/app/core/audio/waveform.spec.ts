import { computeWaveformPeaks } from './waveform';

/** A fake `AudioBuffer` carrying a single-channel `Float32Array` with a known shape. */
function fakeAudioBuffer(channelData: Float32Array): AudioBuffer {
    return {
        getChannelData: () => channelData,
        length: channelData.length,
        numberOfChannels: 1,
        sampleRate: 48000,
    } as unknown as AudioBuffer;
}

/**
 * Stands in for `AudioContext` the way `crypto.subtle`-dependent code elsewhere in this codebase
 * stubs the Web Crypto API: `decodeAudioData` is not something a synthetic `ArrayBuffer` of
 * arbitrary bytes can actually decode, so the real implementation is swapped out entirely.
 */
class FakeAudioContext {
    constructor(private readonly audioBuffer: AudioBuffer) {}

    decodeAudioData(_data: ArrayBuffer, success?: (buffer: AudioBuffer) => void): Promise<AudioBuffer> {
        success?.(this.audioBuffer);
        return Promise.resolve(this.audioBuffer);
    }

    close(): Promise<void> {
        return Promise.resolve();
    }
}

class FailingAudioContext {
    decodeAudioData(_data: ArrayBuffer, _success?: unknown, error?: (err: DOMException) => void): Promise<AudioBuffer> {
        const reason = new DOMException('cannot decode', 'EncodingError');
        error?.(reason);
        return Promise.reject(reason);
    }

    close(): Promise<void> {
        return Promise.resolve();
    }
}

describe('computeWaveformPeaks', () => {
    let originalAudioContext: typeof AudioContext;

    beforeEach(() => {
        originalAudioContext = window.AudioContext;
    });

    afterEach(() => {
        (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
    });

    it('returns barCount peaks normalized into 0..1', async () => {
        const channel = new Float32Array(400);
        for (let i = 0; i < channel.length; i++) {
            // A ramp so different buckets have different peaks, with a known maximum.
            channel[i] = (i / channel.length) * 0.5;
        }
        channel[channel.length - 1] = 1;

        (window as unknown as { AudioContext: unknown }).AudioContext = class {
            constructor() {
                return new FakeAudioContext(fakeAudioBuffer(channel));
            }
        };

        const peaks = await computeWaveformPeaks(new ArrayBuffer(8), 20);

        expect(peaks.length).toBe(20);
        for (const peak of peaks) {
            expect(peak).toBeGreaterThanOrEqual(0);
            expect(peak).toBeLessThanOrEqual(1);
            expect(Number.isNaN(peak)).toBeFalse();
        }
        // The loudest bucket (containing the ramp's final sample) normalizes to exactly 1.
        expect(Math.max(...peaks)).toBeCloseTo(1, 5);
    });

    it('defaults to 40 bars when no barCount is given', async () => {
        const channel = new Float32Array(200).fill(0.5);
        (window as unknown as { AudioContext: unknown }).AudioContext = class {
            constructor() {
                return new FakeAudioContext(fakeAudioBuffer(channel));
            }
        };

        const peaks = await computeWaveformPeaks(new ArrayBuffer(8));
        expect(peaks.length).toBe(40);
    });

    it('returns flat zeros, not NaN, for a silent (all-zero) recording', async () => {
        const channel = new Float32Array(100).fill(0);
        (window as unknown as { AudioContext: unknown }).AudioContext = class {
            constructor() {
                return new FakeAudioContext(fakeAudioBuffer(channel));
            }
        };

        const peaks = await computeWaveformPeaks(new ArrayBuffer(8), 16);

        expect(peaks.length).toBe(16);
        expect(peaks.every((peak) => peak === 0)).toBeTrue();
    });

    it('falls back to flat zeros when decoding fails', async () => {
        (window as unknown as { AudioContext: unknown }).AudioContext = class {
            constructor() {
                return new FailingAudioContext();
            }
        };

        const peaks = await computeWaveformPeaks(new ArrayBuffer(8), 10);

        expect(peaks.length).toBe(10);
        expect(peaks.every((peak) => peak === 0)).toBeTrue();
    });
});
