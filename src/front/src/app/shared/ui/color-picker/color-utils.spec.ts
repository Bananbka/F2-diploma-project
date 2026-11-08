import { hexToHsv, hsvToHex, normalizeHex } from './color-utils';

describe('color-utils', () => {
    it('normalises hex with or without #, short form and case', () => {
        expect(normalizeHex('A358F9')).toBe('#a358f9');
        expect(normalizeHex(' #A358f9 ')).toBe('#a358f9');
        expect(normalizeHex('#fa0')).toBe('#ffaa00');
    });

    it('rejects invalid hex', () => {
        for (const bad of ['', '#12', '#12345', '#1234567', 'gggggg', '#12 456']) {
            expect(normalizeHex(bad)).toBeNull();
        }
    });

    it('converts primaries to HSV', () => {
        expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
        expect(hexToHsv('#00ff00').h).toBe(120);
        expect(hexToHsv('#0000ff').h).toBe(240);
        expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
        expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 });
    });

    it('converts HSV to hex', () => {
        expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe('#ff0000');
        expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
        expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe('#00ff00');
        expect(hsvToHex({ h: 240, s: 1, v: 0.5 })).toBe('#000080');
    });

    it('round-trips every colour on a coarse grid', () => {
        for (const r of [0, 51, 128, 255]) {
            for (const g of [0, 77, 200, 255]) {
                for (const b of [0, 9, 128, 255]) {
                    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
                    expect(hsvToHex(hexToHsv(hex))).toBe(hex);
                }
            }
        }
    });
});
