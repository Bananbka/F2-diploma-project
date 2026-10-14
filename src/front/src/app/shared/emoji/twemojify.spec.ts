import { escapeHtml, twemojifyHtml } from './twemojify';

describe('twemojify', () => {
    describe('escapeHtml', () => {
        it('leaves plain text with no special characters unchanged', () => {
            expect(escapeHtml('hello world')).toBe('hello world');
        });

        it('escapes every HTML-significant character', () => {
            expect(escapeHtml(`<script>alert('x') & "y"</script>`)).toBe(
                '&lt;script&gt;alert(&#39;x&#39;) &amp; &quot;y&quot;&lt;/script&gt;'
            );
        });
    });

    describe('twemojifyHtml', () => {
        it('returns escaped plain text unchanged when there is no emoji', () => {
            expect(twemojifyHtml('hello world')).toBe('hello world');
        });

        it('HTML-escapes plain text before any emoji replacement', () => {
            expect(twemojifyHtml('<b>hi</b>')).toBe('&lt;b&gt;hi&lt;/b&gt;');
        });

        it('replaces an emoji with an <img> pointing at the self-hosted asset', () => {
            const html = twemojifyHtml('😀');
            expect(html).toContain('<img');
            expect(html).toContain('class="twemoji"');
            expect(html).toContain('src="/assets/emoji/1f600.svg"');
            expect(html).toContain('alt="😀"');
        });

        it('replaces emoji inside surrounding text without touching the rest', () => {
            const html = twemojifyHtml('hi 😀 there');
            expect(html).toBe(
                'hi <img class="twemoji" draggable="false" alt="😀" src="/assets/emoji/1f600.svg"/> there'
            );
        });

        it('resolves a multi-codepoint ZWJ sequence to its own composed asset', () => {
            const html = twemojifyHtml('❤️‍🔥');
            expect(html).toContain('src="/assets/emoji/2764-fe0f-200d-1f525.svg"');
        });

        it('never emits unescaped markup for a message containing script-like content and emoji', () => {
            const html = twemojifyHtml('<img src=x onerror=alert(1)> 😀');
            // The attacker's own <img> tag never survives as real markup — it is fully escaped to
            // inert text (the literal substring "onerror=" is still present, but only inside that
            // escaped, inert text, never as a live attribute on an actual element).
            expect(html).not.toContain('<img src=x onerror=alert(1)>');
            expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
            expect(html).toContain('src="/assets/emoji/1f600.svg"');
            // Twemoji's own <img> tag for the emoji carries no "on*" handler of its own.
            expect(html).not.toMatch(/<img class="twemoji"[^>]*onerror/);
        });
    });
});
