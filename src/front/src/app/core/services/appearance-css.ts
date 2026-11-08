import { Appearance, BUBBLE_RADIUS_DEFAULT, FONT_STACKS, GRADIENT_CSS } from '../models/appearance.model';

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
/** A representative colour of whatever is behind the messages, or null for the default background. */
export function baseColorOf(a: Appearance, imageColor: string | null): string | null {
    const bg = a.background;
    if (bg.kind === 'color') {
        return bg.color;
    }
    if (bg.kind === 'gradient' && bg.gradient) {
        return averageStops(GRADIENT_CSS[bg.gradient]);
    }
    if (bg.kind === 'image') {
        // The picture's average, darkened by the veil over it; a safe dark base until it is known.
        const dim = (bg.image?.dim ?? 0) / 100;
        return mixHex(imageColor ?? '#101014', '#000000', dim);
    }
    return null;
}

export function appearanceVars(a: Appearance, imageColor: string | null = null): Record<string, string> {
    const vars: Record<string, string> = {
        '--chat-font-size': `${a.font_size}px`,
        '--chat-font-scale': String(a.font_size / 15),
        '--chat-font-family': FONT_STACKS[a.font_family],
    };
    // Only when changed, so the default keeps the stylesheet's own radius.
    if (a.bubble_radius !== BUBBLE_RADIUS_DEFAULT) {
        vars['--bubble-radius'] = `${a.bubble_radius}px`;
        // Media inside a bubble sits one padding in from its edge, so its corners follow the bubble's.
        vars['--media-radius'] = `max(0px, calc(${a.bubble_radius}px - 0.625rem))`;
    }
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
    const base = baseColorOf(a, imageColor);
    if (base && /^#[0-9a-f]{6}$/i.test(base)) {
        vars['--chat-meta-accent'] = readableTextColor(base);
        vars['--chat-meta-fg'] = mutedOn(base);
        const [r, g, b] = parseHex(readableTextColor(base));
        vars['--chat-chip-bg'] = `rgb(${r} ${g} ${b} / 12%)`;
        vars['--chat-chip-border'] = mutedOn(base, 3);
        // Text drawn straight on the background (empty states, dividers, notices) gets a translucent
        // backing of the background's own colour, so a busy picture cannot swallow it.
        const [br, bg2, bb] = parseHex(base);
        vars['--chat-overlay-bg'] = `rgb(${br} ${bg2} ${bb} / 62%)`;
        vars['--chat-overlay-blur'] = 'blur(8px)';
    }
    // Reactions I made are tinted with my bubble colour when it stands out from the chat background,
    // otherwise with the readable accent, so the "mine" state stays distinct and at least 3:1.
    if (a.own_bubble_color) {
        const backdrop = base && /^#[0-9a-f]{6}$/i.test(base) ? base : '#0a0a0c';
        const tint =
            contrastRatio(a.own_bubble_color, backdrop) >= 3 ? a.own_bubble_color : readableTextColor(backdrop);
        const [r, g, b] = parseHex(tint);
        vars['--chat-chip-mine-border'] = tint;
        vars['--chat-chip-mine-bg'] = `rgb(${r} ${g} ${b} / 25%)`;
    }
    return vars;
}
