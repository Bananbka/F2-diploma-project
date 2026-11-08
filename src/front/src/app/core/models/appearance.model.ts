export const FONT_FAMILIES = ['inter', 'system', 'serif', 'mono', 'rounded'] as const;
export type AppearanceFontFamily = (typeof FONT_FAMILIES)[number];

export const GRADIENT_PRESETS = ['aurora', 'dusk', 'ocean', 'forest', 'sunset'] as const;
export type AppearanceGradient = (typeof GRADIENT_PRESETS)[number];

export type AppearanceBackgroundKind = 'default' | 'color' | 'gradient';

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_DEFAULT = 15;

export interface AppearanceBackground {
    kind: AppearanceBackgroundKind;
    color: string | null;
    gradient: AppearanceGradient | null;
}

/** The document stored at `/profile/me/appearance`. Replace semantics: always sent whole. */
export interface Appearance {
    font_size: number;
    font_family: AppearanceFontFamily;
    own_bubble_color: string | null;
    other_bubble_color: string | null;
    background: AppearanceBackground;
    version: 1;
}

export const DEFAULT_APPEARANCE: Appearance = {
    font_size: FONT_SIZE_DEFAULT,
    font_family: 'inter',
    own_bubble_color: null,
    other_bubble_color: null,
    background: { kind: 'default', color: null, gradient: null },
    version: 1,
};

/** Twemoji stays first in every stack so emoji render consistently whatever the text font is. */
export const FONT_STACKS: Record<AppearanceFontFamily, string> = {
    inter: 'var(--font-sans)',
    system: "'Twemoji', system-ui, -apple-system, 'Segoe UI', sans-serif",
    serif: "'Twemoji', Georgia, 'Times New Roman', serif",
    mono: "'Twemoji', var(--font-mono)",
    rounded: "'Twemoji', 'Nunito', ui-rounded, 'SF Pro Rounded', system-ui, sans-serif",
};

export const FONT_LABELS: Record<AppearanceFontFamily, string> = {
    inter: 'Inter (default)',
    system: 'System',
    serif: 'Serif',
    mono: 'Monospace',
    rounded: 'Rounded',
};

/** The five gradient presets, defined once and shared by the chat and the settings swatches. */
export const GRADIENT_CSS: Record<AppearanceGradient, string> = {
    aurora: 'linear-gradient(135deg, #0f2027 0%, #203a43 45%, #2c5364 100%)',
    dusk: 'linear-gradient(135deg, #1a1033 0%, #3b1f5e 55%, #6b2f7a 100%)',
    ocean: 'linear-gradient(135deg, #021b3a 0%, #0a3d7a 60%, #1565a8 100%)',
    forest: 'linear-gradient(135deg, #0b1f14 0%, #14452f 60%, #1f6b46 100%)',
    sunset: 'linear-gradient(135deg, #2b1030 0%, #7a2a3f 55%, #b8573a 100%)',
};

export const BUBBLE_SWATCHES: readonly string[] = ['#a358f9', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];
export const BACKGROUND_SWATCHES: readonly string[] = ['#0a0a0c', '#111827', '#1e1b2e', '#10231c', '#2a1a1a'];
