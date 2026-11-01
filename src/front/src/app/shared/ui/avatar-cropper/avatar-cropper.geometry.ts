/**
 * Pure geometry for the avatar cropper.
 *
 * The model: the picture is shown through a square frame of `frame` px. `zoom` 1 is the "cover"
 * scale — the smaller side of the (rotated) picture exactly fills the frame — so the frame is never
 * showing empty space, at any zoom or position. `cx`/`cy` is the point of the rotated picture, in
 * its own pixels, that sits at the centre of the frame.
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface CropState {
    zoom: number;
    cx: number;
    cy: number;
    rotation: Rotation;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export interface Size {
    width: number;
    height: number;
}

/** The picture's dimensions once rotated: a quarter turn swaps them. */
export function orientedSize(width: number, height: number, rotation: Rotation): Size {
    return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

export function clampZoom(zoom: number): number {
    if (!Number.isFinite(zoom)) {
        return MIN_ZOOM;
    }
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Screen pixels per picture pixel at the current zoom. */
export function scaleOf(state: CropState, width: number, height: number, frame: number): number {
    const oriented = orientedSize(width, height, state.rotation);
    return (frame / Math.min(oriented.width, oriented.height)) * state.zoom;
}

/** Zoom 1, centred, unrotated. */
export function initialState(width: number, height: number): CropState {
    return { zoom: MIN_ZOOM, cx: width / 2, cy: height / 2, rotation: 0 };
}

/**
 * Pull the centre back so the frame stays inside the picture, and the zoom into range. This is the
 * one place the "always covers the frame" invariant is enforced; every other operation ends here.
 */
export function clamp(state: CropState, width: number, height: number, frame: number): CropState {
    const zoom = clampZoom(state.zoom);
    const oriented = orientedSize(width, height, state.rotation);
    const half = frame / (2 * scaleOf({ ...state, zoom }, width, height, frame));

    const within = (value: number, extent: number): number => {
        // At zoom 1 the frame spans the short side exactly; centre rather than fight rounding.
        if (half * 2 >= extent) {
            return extent / 2;
        }
        return Math.min(extent - half, Math.max(half, value));
    };

    return { ...state, zoom, cx: within(state.cx, oriented.width), cy: within(state.cy, oriented.height) };
}

/** Move the picture by (dx, dy) screen pixels — dragging right shows more of the left. */
export function panBy(
    state: CropState,
    dx: number,
    dy: number,
    width: number,
    height: number,
    frame: number
): CropState {
    const scale = scaleOf(state, width, height, frame);
    return clamp({ ...state, cx: state.cx - dx / scale, cy: state.cy - dy / scale }, width, height, frame);
}

/**
 * Change the zoom, keeping the picture point under `anchor` (frame pixels, default the centre)
 * where it is — the behaviour wheel and pinch zoom are expected to have.
 */
export function zoomTo(
    state: CropState,
    zoom: number,
    width: number,
    height: number,
    frame: number,
    anchor: { x: number; y: number } = { x: frame / 2, y: frame / 2 }
): CropState {
    const next = clampZoom(zoom);
    const before = scaleOf(state, width, height, frame);
    const after = scaleOf({ ...state, zoom: next }, width, height, frame);

    const offsetX = anchor.x - frame / 2;
    const offsetY = anchor.y - frame / 2;
    const pointX = state.cx + offsetX / before;
    const pointY = state.cy + offsetY / before;

    return clamp(
        { ...state, zoom: next, cx: pointX - offsetX / after, cy: pointY - offsetY / after },
        width,
        height,
        frame
    );
}

/** A quarter turn, carrying the centre with the picture so what is in view stays in view. */
export function rotate(state: CropState, direction: 1 | -1, width: number, height: number, frame: number): CropState {
    const oriented = orientedSize(width, height, state.rotation);
    const rotation = ((state.rotation + (direction === 1 ? 90 : 270)) % 360) as Rotation;

    const centre =
        direction === 1
            ? { cx: oriented.height - state.cy, cy: state.cx }
            : { cx: state.cy, cy: oriented.width - state.cx };

    return clamp({ ...state, ...centre, rotation }, width, height, frame);
}

/** The square of the rotated picture that is visible, in its own pixels. */
export function sourceRect(
    state: CropState,
    width: number,
    height: number,
    frame: number
): { x: number; y: number; size: number } {
    const size = frame / scaleOf(state, width, height, frame);
    return { x: state.cx - size / 2, y: state.cy - size / 2, size };
}

/**
 * Canvas transform that paints the crop into an `out`-pixel square: a uniform scale plus the
 * translation of the rotated picture's origin. The caller then moves to the rotated picture's centre,
 * rotates, and draws the bitmap centred on it.
 */
export function viewTransform(
    state: CropState,
    width: number,
    height: number,
    frame: number,
    out: number
): { scale: number; tx: number; ty: number } {
    const scale = scaleOf(state, width, height, frame) * (out / frame);
    return { scale, tx: out / 2 - state.cx * scale, ty: out / 2 - state.cy * scale };
}

/** Shrink to fit `max` on the longer side, never enlarging. */
export function fitWithin(width: number, height: number, max: number): Size {
    const longest = Math.max(width, height);
    if (longest <= max) {
        return { width, height };
    }
    const ratio = max / longest;
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
