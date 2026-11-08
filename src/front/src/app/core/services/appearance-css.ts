import { Appearance, FONT_STACKS, GRADIENT_CSS } from '../models/appearance.model';

const NEAR_BLACK = '#111111';
const WHITE = '#ffffff';

function channel(value: number): number {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) {
        return 0;
    }
    const n = parseInt(m[1], 16);
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black, whichever reads better on `background`. */
export function readableTextColor(background: string): string {
    return contrastRatio(background, WHITE) >= contrastRatio(background, NEAR_BLACK) ? WHITE : NEAR_BLACK;
}

/**
 * CSS custom properties for an appearance. Colours and background are emitted only when set, so an
 * untouched profile leaves every `var(--x, fallback)` on its fallback and the look is unchanged.
 */
export function appearanceVars(a: Appearance): Record<string, string> {
    const vars: Record<string, string> = {
        '--chat-font-size': `${a.font_size}px`,
        '--chat-font-scale': String(a.font_size / 15),
        '--chat-font-family': FONT_STACKS[a.font_family],
    };
    if (a.own_bubble_color) {
        vars['--bubble-own-bg'] = a.own_bubble_color;
        vars['--bubble-own-fg'] = readableTextColor(a.own_bubble_color);
    }
    if (a.other_bubble_color) {
        vars['--bubble-other-bg'] = a.other_bubble_color;
        vars['--bubble-other-fg'] = readableTextColor(a.other_bubble_color);
    }
    const bg = a.background;
    if (bg.kind === 'color' && bg.color) {
        vars['--chat-bg'] = bg.color;
    } else if (bg.kind === 'gradient' && bg.gradient) {
        vars['--chat-bg'] = GRADIENT_CSS[bg.gradient];
    }
    return vars;
}
