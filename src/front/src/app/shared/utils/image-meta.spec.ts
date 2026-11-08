import { mimeFromName, resolveImageType, sniffImageType, typeMayBeTransparent } from './image-meta';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('image-meta', () => {
    it('recognises formats by their first bytes', () => {
        expect(sniffImageType(PNG)).toBe('image/png');
        expect(sniffImageType(JPEG)).toBe('image/jpeg');
        expect(sniffImageType(GIF)).toBe('image/gif');
        expect(sniffImageType(WEBP)).toBe('image/webp');
        expect(sniffImageType(new Uint8Array([1, 2, 3]))).toBeNull();
    });

    it('reads a type from a file name', () => {
        expect(mimeFromName('Circle.PNG')).toBe('image/png');
        expect(mimeFromName('notes.txt')).toBeNull();
    });

    it('trusts the bytes over a generic declared type, then the declared image type, then the name', () => {
        expect(resolveImageType('application/octet-stream', 'a.bin', PNG)).toBe('image/png');
        expect(resolveImageType('IMAGE/WEBP', 'a')).toBe('image/webp');
        expect(resolveImageType(undefined, 'circle.png')).toBe('image/png');
        expect(resolveImageType('application/octet-stream', 'x')).toBeNull();
    });

    it('flags only formats that can be transparent', () => {
        expect(typeMayBeTransparent('image/png')).toBeTrue();
        expect(typeMayBeTransparent('image/webp')).toBeTrue();
        expect(typeMayBeTransparent('image/gif')).toBeTrue();
        expect(typeMayBeTransparent('image/jpeg')).toBeFalse();
        expect(typeMayBeTransparent(null)).toBeFalse();
    });
});
