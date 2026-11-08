export interface Hsv {
    /** Degrees, 0 to 360 (360 is normalised to 0). */
    readonly h: number;
    /** 0 to 1. */
    readonly s: number;
    /** 0 to 1. */
    readonly v: number;
}

const HEX_RE = /^#?([0-9a-f]{6})$/i;
const SHORT_HEX_RE = /^#?([0-9a-f]{3})$/i;

/** Accepts `rrggbb`, `#rrggbb` and `#rgb`; returns lowercase `#rrggbb`, or null when invalid. */
export function normalizeHex(input: string): string | null {
    const text = input.trim();
    const long = HEX_RE.exec(text);
    if (long) {
        return `#${long[1].toLowerCase()}`;
    }
    const short = SHORT_HEX_RE.exec(text);
    if (short) {
        return `#${short[1]
            .toLowerCase()
            .split('')
            .map((c) => c + c)
            .join('')}`;
    }
    return null;
}

export function hexToHsv(hex: string): Hsv {
    const normalized = normalizeHex(hex) ?? '#000000';
    const r = parseInt(normalized.slice(1, 3), 16) / 255;
    const g = parseInt(normalized.slice(3, 5), 16) / 255;
    const b = parseInt(normalized.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let h = 0;
    if (delta !== 0) {
        if (max === r) {
            h = ((g - b) / delta) % 6;
        } else if (max === g) {
            h = (b - r) / delta + 2;
        } else {
            h = (r - g) / delta + 4;
        }
        h *= 60;
        if (h < 0) {
            h += 360;
        }
    }
    return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
    const hue = (((h % 360) + 360) % 360) / 60;
    const c = v * s;
    const x = c * (1 - Math.abs((hue % 2) - 1));
    const m = v - c;
    const [r, g, b] =
        hue < 1
            ? [c, x, 0]
            : hue < 2
              ? [x, c, 0]
              : hue < 3
                ? [0, c, x]
                : hue < 4
                  ? [0, x, c]
                  : hue < 5
                    ? [x, 0, c]
                    : [c, 0, x];
    const channel = (n: number): string =>
        Math.round((n + m) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
