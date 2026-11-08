import { DEFAULT_APPEARANCE, GRADIENT_CSS } from '../models/appearance.model';
import { appearanceVars, contrastRatio, readableTextColor, relativeLuminance } from './appearance-css';

describe('appearance-css', () => {
    it('computes WCAG luminance at the extremes', () => {
        expect(relativeLuminance('#000000')).toBe(0);
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 3);
    });

    it('picks white on dark and near-black on light backgrounds', () => {
        expect(readableTextColor('#0a0a0c')).toBe('#ffffff');
        expect(readableTextColor('#ffffff')).toBe('#111111');
        expect(readableTextColor('#f5e663')).toBe('#111111');
    });

    it('emits only font variables for the defaults', () => {
        const vars = appearanceVars(DEFAULT_APPEARANCE);
        expect(vars['--chat-font-scale']).toBe('1');
        expect(vars['--bubble-own-bg']).toBeUndefined();
        expect(vars['--chat-bg']).toBeUndefined();
    });

    it('emits colours, readable text and the background when set', () => {
        const vars = appearanceVars({
            ...DEFAULT_APPEARANCE,
            font_family: 'serif',
            own_bubble_color: '#ffff00',
            background: { kind: 'gradient', color: null, gradient: 'ocean' },
        });
        expect(vars['--bubble-own-fg']).toBe('#111111');
        expect(vars['--chat-bg']).toBe(GRADIENT_CSS.ocean);
        expect(vars['--chat-font-family']).toContain('Twemoji');
    });
    it('keeps every derived accent at 3:1 or better against its bubble, for any colour', () => {
        for (const colour of ['#a358f9', '#ef4444', '#ffff00', '#ffffff', '#000000', '#808080', '#10b981']) {
            const vars = appearanceVars({ ...DEFAULT_APPEARANCE, own_bubble_color: colour });
            expect(contrastRatio(vars['--bubble-own-accent'], colour)).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(vars['--bubble-own-fg-muted'], colour)).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(vars['--bubble-own-accent-fg'], vars['--bubble-own-accent'])).toBeGreaterThanOrEqual(
                3
            );
        }
    });

    it('derives reaction chip colours from the background and the own bubble colour', () => {
        const vars = appearanceVars({
            ...DEFAULT_APPEARANCE,
            own_bubble_color: '#ef4444',
            background: { kind: 'color', color: '#7a1f4a', gradient: null },
        });
        expect(contrastRatio(vars['--chat-chip-border'], '#7a1f4a')).toBeGreaterThanOrEqual(3);
        expect(vars['--chat-chip-mine-border']).toBeDefined();
        expect(vars['--chat-chip-mine-bg']).toContain('/ 25%');
        const defaults = appearanceVars(DEFAULT_APPEARANCE);
        expect(defaults['--chat-chip-bg']).toBeUndefined();
        expect(defaults['--chat-chip-mine-bg']).toBeUndefined();
    });

    it('derives the other-bubble accents the same way and leaves them unset by default', () => {
        const vars = appearanceVars({ ...DEFAULT_APPEARANCE, other_bubble_color: '#f5e663' });
        expect(vars['--bubble-other-accent']).toBe('#111111');
        expect(appearanceVars(DEFAULT_APPEARANCE)['--bubble-other-accent']).toBeUndefined();
        expect(appearanceVars(DEFAULT_APPEARANCE)['--chat-meta-fg']).toBeUndefined();
    });

    it('keeps time and ticks readable on a light, dark or gradient chat background', () => {
        const light = appearanceVars({
            ...DEFAULT_APPEARANCE,
            background: { kind: 'color', color: '#f5f5f5', gradient: null },
        });
        expect(contrastRatio(light['--chat-meta-fg'], '#f5f5f5')).toBeGreaterThanOrEqual(4.5);
        expect(light['--chat-meta-accent']).toBe('#111111');
        const sunset = appearanceVars({
            ...DEFAULT_APPEARANCE,
            background: { kind: 'gradient', color: null, gradient: 'sunset' },
        });
        expect(sunset['--chat-meta-accent']).toBe('#ffffff');
    });

    it('emits the bubble radius only when it differs from the default', () => {
        expect(appearanceVars(DEFAULT_APPEARANCE)['--bubble-radius']).toBeUndefined();
        const vars = appearanceVars({ ...DEFAULT_APPEARANCE, bubble_radius: 4 });
        expect(vars['--bubble-radius']).toBe('4px');
        expect(vars['--media-radius']).toContain('4px');
    });

    it('derives the meta colours from the picture average combined with the dim, with a dark fallback', () => {
        const image = {
            fit: 'cover',
            position_x: 50,
            position_y: 50,
            zoom: 100,
            dim: 0,
            blur: 0,
            version: 'v',
        } as const;
        const light = appearanceVars(
            { ...DEFAULT_APPEARANCE, background: { kind: 'image', color: null, gradient: null, image } },
            '#f0f0f0'
        );
        expect(light['--chat-meta-accent']).toBe('#111111');
        const dimmed = appearanceVars(
            {
                ...DEFAULT_APPEARANCE,
                background: { kind: 'image', color: null, gradient: null, image: { ...image, dim: 80 } },
            },
            '#f0f0f0'
        );
        expect(dimmed['--chat-meta-accent']).toBe('#ffffff');
        const unknown = appearanceVars({
            ...DEFAULT_APPEARANCE,
            background: { kind: 'image', color: null, gradient: null, image },
        });
        expect(unknown['--chat-meta-accent']).toBe('#ffffff');
    });
});
