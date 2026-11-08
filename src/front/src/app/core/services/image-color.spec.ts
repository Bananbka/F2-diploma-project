import { averageColorOfPixels } from './image-color';

describe('averageColorOfPixels', () => {
    it('averages opaque pixels', () => {
        expect(averageColorOfPixels([255, 0, 0, 255, 0, 0, 255, 255])).toBe('#800080');
    });

    it('ignores transparent pixels', () => {
        expect(averageColorOfPixels([10, 20, 30, 255, 255, 255, 255, 0])).toBe('#0a141e');
    });

    it('returns null when nothing is opaque', () => {
        expect(averageColorOfPixels([1, 2, 3, 0])).toBeNull();
        expect(averageColorOfPixels([])).toBeNull();
    });
});
