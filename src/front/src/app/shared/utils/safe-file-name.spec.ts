import { safeFileName } from './safe-file-name';

describe('safeFileName', () => {
    it('leaves an ordinary name alone, including non-Latin text and inner dots', () => {
        expect(safeFileName('Звіт за 2026.final.pdf')).toBe('Звіт за 2026.final.pdf');
    });

    it('removes bidirectional overrides, so an extension cannot be visually reversed', () => {
        // Renders as "invoiceexe.pdf" with the override in place.
        expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
        expect(safeFileName('a\u2066b\u2069c\u200Fd\u061Ce.txt')).toBe('abcde.txt');
    });

    it('removes control characters and line separators', () => {
        expect(safeFileName('re\u0000po\nrt\r\t\u007f\u0085\u2028.pdf')).toBe('report.pdf');
    });

    it('keeps the name to a single path segment', () => {
        expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
        expect(safeFileName('C:\\Users\\me\\x.txt')).toBe('C:_Users_me_x.txt');
    });

    it('drops leading dots and trailing dots or spaces', () => {
        expect(safeFileName('  ..hidden.txt. . ')).toBe('hidden.txt');
    });

    it('falls back when nothing displayable is left, or the value is not a string', () => {
        expect(safeFileName('\u202E\u0000 . ')).toBe('attachment');
        expect(safeFileName('')).toBe('attachment');
        expect(safeFileName(undefined)).toBe('attachment');
    });

    it('caps the length but keeps the extension', () => {
        const cleaned = safeFileName('x'.repeat(500) + '.pdf');
        expect(cleaned.length).toBe(200);
        expect(cleaned.endsWith('.pdf')).toBeTrue();
    });
});
