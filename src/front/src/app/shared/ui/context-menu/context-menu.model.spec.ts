import { EDGE_GAP, placeAtPoint, placeBeside, tidyEntries } from './context-menu.model';

describe('context menu placement', () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 200, height: 300 };

    it('opens at the point when there is room', () => {
        expect(placeAtPoint({ x: 100, y: 120 }, size, viewport)).toEqual({ x: 100, y: 120 });
    });

    it('flips to the left of the point near the right edge', () => {
        const placed = placeAtPoint({ x: 950, y: 120 }, size, viewport);
        expect(placed.x).toBe(750);
    });

    it('flips above the point near the bottom edge', () => {
        const placed = placeAtPoint({ x: 100, y: 700 }, size, viewport);
        expect(placed.y).toBe(400);
    });

    it('never leaves the viewport, even for a point far outside it', () => {
        const placed = placeAtPoint({ x: 5000, y: 5000 }, size, viewport);
        expect(placed.x).toBe(viewport.width - size.width - EDGE_GAP);
        expect(placed.y).toBe(viewport.height - size.height - EDGE_GAP);

        const negative = placeAtPoint({ x: -50, y: -50 }, size, viewport);
        expect(negative).toEqual({ x: EDGE_GAP, y: EDGE_GAP });
    });

    it('puts a submenu to the right of its parent, or to the left when there is no room', () => {
        const roomy = placeBeside({ left: 100, right: 300, top: 200 }, size, viewport);
        expect(roomy.x).toBe(296);

        const cramped = placeBeside({ left: 700, right: 900, top: 200 }, size, viewport);
        expect(cramped.x).toBe(700 - 200 + 4);
    });

    it('keeps a submenu inside the bottom of the viewport', () => {
        const placed = placeBeside({ left: 100, right: 300, top: 700 }, size, viewport);
        expect(placed.y).toBe(viewport.height - size.height - EDGE_GAP);
    });
});

describe('tidyEntries', () => {
    const item = (label: string) => ({ label });

    it('drops leading, trailing and doubled separators', () => {
        const out = tidyEntries([
            { separator: true },
            item('a'),
            { separator: true },
            { separator: true },
            item('b'),
            { separator: true },
        ]);
        expect(out.length).toBe(3);
        expect('separator' in out[1]).toBeTrue();
    });
});
