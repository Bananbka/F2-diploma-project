import { LocationPayload, validateLocation } from '../models/message-payload';

export type GeolocationFailure = 'unsupported' | 'denied' | 'unavailable' | 'timeout' | 'invalid';

export type GeolocationResult = { ok: true; location: LocationPayload } | { ok: false; reason: GeolocationFailure };

export const GEOLOCATION_MESSAGES: Record<GeolocationFailure, string> = {
    unsupported: 'This browser or connection does not offer location access.',
    denied: 'Location access was denied. Allow it for this site in your browser settings, then try again.',
    unavailable: 'Your position could not be determined right now.',
    timeout: 'Finding your position took too long.',
    invalid: 'The device reported a position that cannot be used.',
};

const TIMEOUT_MS = 15_000;

/**
 * One position fix, asked for once. Never retries on its own: every attempt is an explicit user
 * action, because a silent retry loop would keep re-prompting for a permission already refused.
 */
export function requestPosition(
    geolocation: Geolocation | null = typeof navigator === 'undefined' ? null : (navigator.geolocation ?? null)
): Promise<GeolocationResult> {
    if (!geolocation) {
        return Promise.resolve({ ok: false, reason: 'unsupported' });
    }

    return new Promise((resolve) => {
        try {
            geolocation.getCurrentPosition(
                (position) => {
                    try {
                        const { latitude, longitude, accuracy } = position.coords;
                        resolve({
                            ok: true,
                            location: validateLocation({
                                lat: latitude,
                                lon: longitude,
                                accuracy: Number.isFinite(accuracy) ? accuracy : null,
                                label: null,
                            }),
                        });
                    } catch {
                        resolve({ ok: false, reason: 'invalid' });
                    }
                },
                (error) => {
                    // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
                    resolve({
                        ok: false,
                        reason: error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable',
                    });
                },
                { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: 0 }
            );
        } catch {
            resolve({ ok: false, reason: 'unsupported' });
        }
    });
}
