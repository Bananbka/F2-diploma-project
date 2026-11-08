export const FONT_FAMILIES = ['inter', 'system', 'serif', 'mono', 'rounded'] as const;
export type AppearanceFontFamily = (typeof FONT_FAMILIES)[number];

export const GRADIENT_PRESETS = ['aurora', 'dusk', 'ocean', 'forest', 'sunset'] as const;
export type AppearanceGradient = (typeof GRADIENT_PRESETS)[number];

export type AppearanceBackgroundKind = 'default' | 'color' | 'gradient' | 'image';
export type BackgroundImageFit = 'cover' | 'contain' | 'tile';

/** The built-in views of the rail that can be hidden. The wire names, not the client's internal ids. */
export const HIDDEN_VIEW_IDS = ['all', 'unread', 'direct', 'groups', 'channels', 'contacts'] as const;
export type HiddenViewId = (typeof HIDDEN_VIEW_IDS)[number];

export const BUBBLE_RADIUS_MIN = 0;
export const BUBBLE_RADIUS_MAX = 28;
export const BUBBLE_RADIUS_DEFAULT = 19;

/** Upload limits, mirrored from the server so a bad file is refused before it is sent. */
export const BACKGROUND_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const BACKGROUND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface BackgroundImageSettings {
    fit: BackgroundImageFit;
    position_x: number;
    position_y: number;
    /** Percent, 100 to 300. */
    zoom: number;
    /** Percent of black laid over the image, 0 to 80. */
    dim: number;
    /** Pixels, 0 to 20. */
    blur: number;
    version: string | null;
}

export const DEFAULT_BACKGROUND_IMAGE: BackgroundImageSettings = {
    fit: 'cover',
    position_x: 50,
    position_y: 50,
    zoom: 100,
    dim: 0,
    blur: 0,
    version: null,
};

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_DEFAULT = 15;

export interface AppearanceBackground {
    kind: AppearanceBackgroundKind;
    color: string | null;
    gradient: AppearanceGradient | null;
    image?: BackgroundImageSettings | null;
}

/** The document stored at `/profile/me/appearance`. Replace semantics: always sent whole. */
export interface Appearance {
    font_size: number;
    font_family: AppearanceFontFamily;
    bubble_radius: number;
    /** Built-in rail views the user has hidden. At least one chat view (not Contacts) always stays visible. */
    hidden_views: HiddenViewId[];
    own_bubble_color: string | null;
    other_bubble_color: string | null;
    background: AppearanceBackground;
    /** Set whenever an image has been uploaded, even while another background kind is selected. */
    background_image_version: string | null;
    version: 1;
}

export const DEFAULT_APPEARANCE: Appearance = {
    font_size: FONT_SIZE_DEFAULT,
    font_family: 'inter',
    bubble_radius: BUBBLE_RADIUS_DEFAULT,
    hidden_views: [],
    own_bubble_color: null,
    other_bubble_color: null,
    background: { kind: 'default', color: null, gradient: null, image: null },
    background_image_version: null,
    version: 1,
};

/** Fill anything a stored or older document lacks, so a cached copy from before a field existed still loads. */
export function normalizeAppearance(raw: Partial<Appearance> | null | undefined): Appearance {
    const source = raw ?? {};
    const image = source.background?.image;
    return {
        ...DEFAULT_APPEARANCE,
        ...source,
        bubble_radius: typeof source.bubble_radius === 'number' ? source.bubble_radius : BUBBLE_RADIUS_DEFAULT,
        background: {
            ...DEFAULT_APPEARANCE.background,
            ...source.background,
            image: image ? { ...DEFAULT_BACKGROUND_IMAGE, ...image } : null,
        },
        background_image_version: source.background_image_version ?? null,
        hidden_views: Array.isArray(source.hidden_views)
            ? [
                  ...new Set(
                      source.hidden_views.filter((v): v is HiddenViewId =>
                          (HIDDEN_VIEW_IDS as readonly string[]).includes(v)
                      )
                  ),
              ]
            : [],
        version: 1,
    };
}

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
