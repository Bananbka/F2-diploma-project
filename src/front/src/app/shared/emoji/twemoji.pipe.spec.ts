import { TestBed } from '@angular/core/testing';

import { TwemojiPipe } from './twemoji.pipe';

describe('TwemojiPipe', () => {
    let pipe: TwemojiPipe;

    beforeEach(() => {
        TestBed.configureTestingModule({});
        pipe = TestBed.runInInjectionContext(() => new TwemojiPipe());
    });

    it('returns an empty string for null/undefined/empty input', () => {
        expect(pipe.transform(null)).toBe('');
        expect(pipe.transform(undefined)).toBe('');
        expect(pipe.transform('')).toBe('');
    });

    it('sanitizes and renders an emoji as an <img>', () => {
        const result = pipe.transform('😀') as string;
        expect(String(result)).toContain('<img');
        expect(String(result)).toContain('src="/assets/emoji/1f600.svg"');
    });

    it('neutralizes script-like content from untrusted text', () => {
        const result = String(pipe.transform('<script>alert(1)</script>😀'));
        expect(result).not.toContain('<script>');
        expect(result).toContain('src="/assets/emoji/1f600.svg"');
    });
});
