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

function parseHex(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
    return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** `from` moved `t` (0..1) of the way towards `to`. Both `#rrggbb`. */
export function mixHex(from: string, to: string, t: number): string {
    const a = parseHex(from);
    const b = parseHex(to);
    return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/**
 * The readable colour for `background`, softened towards the background as far as it can go while
 * still reaching `minContrast`. Used for secondary text and ticks, which must stay legible on any
 * chosen colour rather than keep the default purple.
 */
export function mutedOn(background: string, minContrast = 4.5): string {
    const strong = readableTextColor(background);
    let best = strong;
    for (let t = 0.1; t <= 0.5; t += 0.1) {
        const candidate = mixHex(strong, background, t);
        if (contrastRatio(candidate, background) < minContrast) {
            break;
        }
        best = candidate;
    }
    return best;
}

/** A single representative colour for a CSS gradient: the average of its hex stops. */
export function averageStops(css: string): string | null {
    const stops = css.match(/#[0-9a-f]{6}/gi);
    if (!stops?.length) {
        return null;
    }
    const sum = stops
        .map(parseHex)
        .reduce<[number, number, number]>((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0]);
    return toHex([sum[0] / stops.length, sum[1] / stops.length, sum[2] / stops.length]);
}

/** Derived accents for text drawn on `background`: the accent itself, the colour on top of it, and a muted tone. */
function accentVars(prefix: string, background: string): Record<string, string> {
    const accent = readableTextColor(background);
    return {
        [`${prefix}-accent`]: accent,
        [`${prefix}-accent-fg`]: background,
        [`${prefix}-fg-muted`]: mutedOn(background),
    };
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
        Object.assign(vars, accentVars('--bubble-own', a.own_bubble_color));
    }
    if (a.other_bubble_color) {
        vars['--bubble-other-bg'] = a.other_bubble_color;
        vars['--bubble-other-fg'] = readableTextColor(a.other_bubble_color);
        Object.assign(vars, accentVars('--bubble-other', a.other_bubble_color));
    }
    const bg = a.background;
    if (bg.kind === 'color' && bg.color) {
        vars['--chat-bg'] = bg.color;
    } else if (bg.kind === 'gradient' && bg.gradient) {
        vars['--chat-bg'] = GRADIENT_CSS[bg.gradient];
    }
    // Time, ticks and quotes sit on the chat background rather than inside a bubble, so they follow it.
    const base =
        bg.kind === 'color'
            ? bg.color
            : bg.kind === 'gradient' && bg.gradient
              ? averageStops(GRADIENT_CSS[bg.gradient])
              : null;
    if (base && /^#[0-9a-f]{6}$/i.test(base)) {
        vars['--chat-meta-accent'] = readableTextColor(base);
        vars['--chat-meta-fg'] = mutedOn(base);
    }
    return vars;
}
