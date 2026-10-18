/**
 * Computes a per-bar peak waveform from recorded audio, for `MessageAttachment.waveform`.
 *
 * Deliberately hand-rolled — this codebase has no audio/waveform library, and a bar count capped
 * at 64 entries (see the backend's `Attachment.waveform`) does not need one. Must run on the
 * plaintext bytes, before `encryptAttachment` — there is no way to decode ciphertext as audio.
 */

const DEFAULT_BAR_COUNT = 40;

/**
 * `AudioContext.decodeAudioData` detaches the `ArrayBuffer` it is given, so this always decodes a
 * copy and leaves the caller's buffer intact for whatever runs next (encryption, upload).
 */
function decodeAudioData(audioContext: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
        const onError = (error: DOMException): void => reject(error);

        // Modern browsers resolve the promise this call already returns; a legacy engine instead
        // calls back via the second/third arguments. Both are wired to the same settlement so
        // either path resolves this promise exactly once in practice.
        const maybePromise = audioContext.decodeAudioData(bytes, resolve, onError) as unknown;
        if (maybePromise && typeof (maybePromise as Promise<AudioBuffer>).then === 'function') {
            (maybePromise as Promise<AudioBuffer>).then(resolve, onError);
        }
    });
}

/**
 * Downsample a decoded recording into `barCount` normalized peaks in `0..1`.
 *
 * Each bucket takes the maximum absolute amplitude of its slice of the first channel — a simple,
 * cheap approximation that still reads as "loud here, quiet there" for a bar chart. The whole array
 * is then normalized against its own max so a quiet recording still fills the available bar height.
 * A silent (or undecodable) recording returns flat zeros rather than `NaN`.
 */
export async function computeWaveformPeaks(bytes: ArrayBuffer, barCount = DEFAULT_BAR_COUNT): Promise<number[]> {
    const AudioContextCtor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
        return new Array(barCount).fill(0);
    }

    const audioContext = new AudioContextCtor();
    try {
        const audioBuffer = await decodeAudioData(audioContext, bytes.slice(0));
        const channel = audioBuffer.getChannelData(0);

        if (channel.length === 0) {
            return new Array(barCount).fill(0);
        }

        const bucketSize = Math.max(1, Math.floor(channel.length / barCount));
        const peaks: number[] = [];
        for (let bar = 0; bar < barCount; bar++) {
            const start = bar * bucketSize;
            const end = bar === barCount - 1 ? channel.length : Math.min(channel.length, start + bucketSize);

            let max = 0;
            for (let i = start; i < end; i++) {
                const abs = Math.abs(channel[i]);
                if (abs > max) {
                    max = abs;
                }
            }
            peaks.push(max);
        }

        const globalMax = Math.max(...peaks);
        if (!Number.isFinite(globalMax) || globalMax <= 0) {
            return new Array(barCount).fill(0);
        }

        return peaks.map((peak) => Math.min(1, peak / globalMax));
    } catch {
        // An encoding this browser cannot decode back, or any other decode failure — a flat
        // waveform is a safe fallback, the same one the renderer already uses for a missing one.
        return new Array(barCount).fill(0);
    } finally {
        await audioContext.close().catch(() => undefined);
    }
}
