import { requestPosition } from './geolocation';

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

function fake(behaviour: (ok: Success, fail: Failure) => void): Geolocation {
    return {
        getCurrentPosition: (ok: Success, fail?: Failure | null) => behaviour(ok, fail as Failure),
        watchPosition: () => 0,
        clearWatch: () => undefined,
    } as Geolocation;
}

const position = (latitude: number, longitude: number, accuracy = 25) =>
    ({ coords: { latitude, longitude, accuracy } }) as GeolocationPosition;

const failure = (code: number) => ({ code }) as GeolocationPositionError;

describe('requestPosition', () => {
    it('returns a validated location on success', async () => {
        const result = await requestPosition(fake((ok) => ok(position(50.45, 30.52, 12))));
        expect(result).toEqual({ ok: true, location: { lat: 50.45, lon: 30.52, accuracy: 12, label: null } });
    });

    it('reports a denied permission', async () => {
        const result = await requestPosition(fake((_, fail) => fail(failure(1))));
        expect(result).toEqual({ ok: false, reason: 'denied' });
    });

    it('reports an unavailable position', async () => {
        const result = await requestPosition(fake((_, fail) => fail(failure(2))));
        expect(result).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('reports a timeout', async () => {
        const result = await requestPosition(fake((_, fail) => fail(failure(3))));
        expect(result).toEqual({ ok: false, reason: 'timeout' });
    });

    it('reports a browser with no geolocation', async () => {
        expect(await requestPosition(null)).toEqual({ ok: false, reason: 'unsupported' });
    });

    it('rejects a nonsense fix from the device', async () => {
        const result = await requestPosition(fake((ok) => ok(position(Number.NaN, 0))));
        expect(result).toEqual({ ok: false, reason: 'invalid' });
        const outOfRange = await requestPosition(fake((ok) => ok(position(120, 0))));
        expect(outOfRange).toEqual({ ok: false, reason: 'invalid' });
    });

    it('asks exactly once and never retries on its own', async () => {
        let calls = 0;
        await requestPosition(
            fake((_, fail) => {
                calls += 1;
                fail(failure(3));
            })
        );
        expect(calls).toBe(1);
    });
});
