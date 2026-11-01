import {
    clamp,
    clampZoom,
    CropState,
    fitWithin,
    initialState,
    MAX_ZOOM,
    MIN_ZOOM,
    orientedSize,
    panBy,
    rotate,
    scaleOf,
    sourceRect,
    viewTransform,
    zoomTo,
} from './avatar-cropper.geometry';

const FRAME = 288;

/** The visible square must lie inside the rotated picture; this is the invariant the module exists for. */
function expectCovered(state: CropState, width: number, height: number): void {
    const oriented = orientedSize(width, height, state.rotation);
    const rect = sourceRect(state, width, height, FRAME);
    const epsilon = 1e-6;
    expect(rect.x).toBeGreaterThanOrEqual(-epsilon);
    expect(rect.y).toBeGreaterThanOrEqual(-epsilon);
    expect(rect.x + rect.size).toBeLessThanOrEqual(oriented.width + epsilon);
    expect(rect.y + rect.size).toBeLessThanOrEqual(oriented.height + epsilon);
}

describe('avatar cropper geometry', () => {
    describe('initial state', () => {
        it('fits the short side of a landscape picture exactly at zoom 1', () => {
            const state = initialState(2000, 1000);
            expect(scaleOf(state, 2000, 1000, FRAME)).toBeCloseTo(FRAME / 1000);
            expect(sourceRect(state, 2000, 1000, FRAME).size).toBeCloseTo(1000);
            expectCovered(state, 2000, 1000);
        });

        it('fits the short side of a portrait picture', () => {
            const state = initialState(600, 1800);
            expect(sourceRect(state, 600, 1800, FRAME).size).toBeCloseTo(600);
            expectCovered(state, 600, 1800);
        });
    });

    describe('zoom limits', () => {
        it('clamps to the range and tolerates garbage', () => {
            expect(clampZoom(0.2)).toBe(MIN_ZOOM);
            expect(clampZoom(99)).toBe(MAX_ZOOM);
            expect(clampZoom(2.5)).toBe(2.5);
            expect(clampZoom(NaN)).toBe(MIN_ZOOM);
        });

        it('zoomTo never leaves the range', () => {
            const state = initialState(1000, 1000);
            expect(zoomTo(state, 100, 1000, 1000, FRAME).zoom).toBe(MAX_ZOOM);
            expect(zoomTo(state, -3, 1000, 1000, FRAME).zoom).toBe(MIN_ZOOM);
        });
    });

    describe('panning', () => {
        it('cannot move at zoom 1 on the short axis', () => {
            const state = initialState(1000, 1000);
            const moved = panBy(state, 500, 500, 1000, 1000, FRAME);
            expect(moved.cx).toBe(500);
            expect(moved.cy).toBe(500);
        });

        it('moves along the long axis of a wide picture but stops at the edge', () => {
            const state = initialState(2000, 1000);
            const right = panBy(state, -100000, 0, 2000, 1000, FRAME);
            expectCovered(right, 2000, 1000);
            expect(sourceRect(right, 2000, 1000, FRAME).x + sourceRect(right, 2000, 1000, FRAME).size).toBeCloseTo(
                2000
            );

            const left = panBy(state, 100000, 0, 2000, 1000, FRAME);
            expect(sourceRect(left, 2000, 1000, FRAME).x).toBeCloseTo(0);
        });

        it('dragging right reveals more of the left of the picture', () => {
            const zoomed = zoomTo(initialState(1000, 1000), 2, 1000, 1000, FRAME);
            const dragged = panBy(zoomed, 20, 0, 1000, 1000, FRAME);
            expect(dragged.cx).toBeLessThan(zoomed.cx);
        });

        it('keeps the picture covering the frame for any sequence of moves', () => {
            let state = initialState(3000, 1200);
            const steps: [number, number, number][] = [
                [400, -50, 3],
                [-5000, 3000, 5],
                [123, 456, 1.5],
                [-90, -90, 8],
                [9999, 9999, 1],
            ];
            for (const [dx, dy, zoom] of steps) {
                state = zoomTo(panBy(state, dx, dy, 3000, 1200, FRAME), zoom, 3000, 1200, FRAME);
                expectCovered(state, 3000, 1200);
            }
        });
    });

    describe('zoom anchoring', () => {
        it('keeps the point under the anchor fixed', () => {
            const start = panBy(zoomTo(initialState(2000, 2000), 2, 2000, 2000, FRAME), -30, 10, 2000, 2000, FRAME);
            const anchor = { x: 200, y: 90 };

            const pointAt = (s: CropState) => {
                const scale = scaleOf(s, 2000, 2000, FRAME);
                return { x: s.cx + (anchor.x - FRAME / 2) / scale, y: s.cy + (anchor.y - FRAME / 2) / scale };
            };

            const before = pointAt(start);
            const after = pointAt(zoomTo(start, 3, 2000, 2000, FRAME, anchor));
            expect(after.x).toBeCloseTo(before.x, 3);
            expect(after.y).toBeCloseTo(before.y, 3);
        });

        it('zooming back out to 1 re-centres a square picture', () => {
            const zoomed = zoomTo(initialState(1000, 1000), 4, 1000, 1000, FRAME, { x: 10, y: 10 });
            const out = zoomTo(zoomed, 1, 1000, 1000, FRAME, { x: 10, y: 10 });
            expect(out.cx).toBeCloseTo(500);
            expect(out.cy).toBeCloseTo(500);
        });
    });

    describe('rotation', () => {
        it('swaps the oriented dimensions on a quarter turn', () => {
            expect(orientedSize(800, 400, 0)).toEqual({ width: 800, height: 400 });
            expect(orientedSize(800, 400, 90)).toEqual({ width: 400, height: 800 });
            expect(orientedSize(800, 400, 180)).toEqual({ width: 800, height: 400 });
            expect(orientedSize(800, 400, 270)).toEqual({ width: 400, height: 800 });
        });

        it('four turns return to the start, in either direction', () => {
            const start = zoomTo(initialState(2000, 1000), 2, 2000, 1000, FRAME);
            let cw = start;
            let ccw = start;
            for (let i = 0; i < 4; i++) {
                cw = rotate(cw, 1, 2000, 1000, FRAME);
                ccw = rotate(ccw, -1, 2000, 1000, FRAME);
            }
            for (const turned of [cw, ccw]) {
                expect(turned.rotation).toBe(0);
                expect(turned.cx).toBeCloseTo(start.cx);
                expect(turned.cy).toBeCloseTo(start.cy);
            }
        });

        it('cycles through the four orientations', () => {
            let state = initialState(100, 100);
            const seen: number[] = [];
            for (let i = 0; i < 4; i++) {
                state = rotate(state, 1, 100, 100, FRAME);
                seen.push(state.rotation);
            }
            expect(seen).toEqual([90, 180, 270, 0]);
            expect(rotate(initialState(100, 100), -1, 100, 100, FRAME).rotation).toBe(270);
        });

        it('keeps the frame covered after turning a wide picture upright', () => {
            let state = panBy(zoomTo(initialState(4000, 1000), 3, 4000, 1000, FRAME), -9999, 0, 4000, 1000, FRAME);
            state = rotate(state, 1, 4000, 1000, FRAME);
            expectCovered(state, 4000, 1000);
            state = rotate(state, -1, 4000, 1000, FRAME);
            expectCovered(state, 4000, 1000);
        });
    });

    describe('clamp', () => {
        it('pulls an out-of-bounds centre back inside', () => {
            const state = clamp({ zoom: 2, cx: -500, cy: 99999, rotation: 0 }, 1000, 1000, FRAME);
            expectCovered(state, 1000, 1000);
        });
    });

    describe('view transform', () => {
        it('maps the centre of the crop to the middle of the output', () => {
            const state = zoomTo(initialState(2000, 1000), 2, 2000, 1000, FRAME);
            const t = viewTransform(state, 2000, 1000, FRAME, 512);
            expect(state.cx * t.scale + t.tx).toBeCloseTo(256);
            expect(state.cy * t.scale + t.ty).toBeCloseTo(256);
        });

        it('scales the visible square to the output size', () => {
            const state = zoomTo(initialState(2000, 1000), 2, 2000, 1000, FRAME);
            const t = viewTransform(state, 2000, 1000, FRAME, 512);
            expect(sourceRect(state, 2000, 1000, FRAME).size * t.scale).toBeCloseTo(512);
        });
    });

    describe('fitWithin', () => {
        it('never enlarges', () => {
            expect(fitWithin(800, 600, 4096)).toEqual({ width: 800, height: 600 });
        });

        it('scales the long side down and keeps the aspect ratio', () => {
            expect(fitWithin(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048 });
            expect(fitWithin(3000, 12000, 4000)).toEqual({ width: 1000, height: 4000 });
        });

        it('never produces a zero dimension', () => {
            expect(fitWithin(1, 100000, 100).width).toBe(1);
        });
    });
});
