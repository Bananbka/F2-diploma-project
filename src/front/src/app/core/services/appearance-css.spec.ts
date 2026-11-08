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
});
