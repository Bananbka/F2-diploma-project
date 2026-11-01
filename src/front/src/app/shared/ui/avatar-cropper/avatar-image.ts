import { CropState, fitWithin, orientedSize, viewTransform } from './avatar-cropper.geometry';

/** A failure with a message that is safe and useful to show the user as is. */
export class AvatarImageError extends Error {}

/** Refuse absurd inputs before decoding; the server's own cap applies to the *output*, not this. */
export const MAX_INPUT_BYTES = 30 * 1024 * 1024;
/** Longest side kept in memory. A phone photo is ~4000px; the crop is 512px, so this loses nothing. */
export const MAX_DECODE_SIDE = 4096;
export const OUTPUT_SIZE = 512;
/** Well under the server's 5 MB avatar cap. */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Reject anything above this many pixels before it is decoded; a 50 MP photo is already far beyond need. */
export const MAX_SOURCE_PIXELS = 50_000_000;
export const MIN_OUTPUT_SIZE = 64;
export const MAX_OUTPUT_SIZE = 1024;

export function clampOutputSize(size: number): number {
    if (!Number.isFinite(size)) {
        return OUTPUT_SIZE;
    }
    return Math.min(MAX_OUTPUT_SIZE, Math.max(MIN_OUTPUT_SIZE, Math.round(size)));
}

/** Throws the user-facing "too large" error for a source of `width` x `height` pixels. */
export function assertPixelBudget(width: number, height: number): void {
    if (width * height > MAX_SOURCE_PIXELS) {
        const megapixels = Math.round((width * height) / 1_000_000);
        throw new AvatarImageError(
            `That image is too large (${megapixels} megapixels). Choose one under ${MAX_SOURCE_PIXELS / 1_000_000} megapixels.`
        );
    }
}

/**
 * Read the pixel dimensions without decoding the picture. An `<img>` reports its natural size once
 * the header has loaded, long before (and without) a full-size bitmap being allocated. The object
 * URL it needs lives only for this call and is revoked on every path out.
 */
function readDimensions(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        const finish = () => {
            image.onload = null;
            image.onerror = null;
            image.src = '';
            URL.revokeObjectURL(url);
        };
        image.onload = () => {
            const size = { width: image.naturalWidth, height: image.naturalHeight };
            finish();
            resolve(size);
        };
        image.onerror = () => {
            finish();
            reject(new AvatarImageError('That image could not be read. Try a JPEG, PNG or WebP file.'));
        };
        image.src = url;
    });
}

/**
 * Decode a picked file to a bitmap with EXIF orientation applied.
 *
 * The size is checked first and the decode happens exactly once, already resized to at most
 * `MAX_DECODE_SIDE`, so peak memory stays bounded regardless of the source. There is deliberately no
 * fallback to a full-size decode. The caller must `close()` the bitmap.
 */
export async function decodeImage(file: File): Promise<ImageBitmap> {
    if (file.type && !file.type.startsWith('image/')) {
        throw new AvatarImageError('That file is not an image.');
    }
    if (file.size === 0) {
        throw new AvatarImageError('That file is empty.');
    }
    if (file.size > MAX_INPUT_BYTES) {
        throw new AvatarImageError('That image is too large. Choose one under 30 MB.');
    }

    const source = await readDimensions(file);
    if (source.width < 1 || source.height < 1) {
        throw new AvatarImageError('That image could not be read. Try a JPEG, PNG or WebP file.');
    }
    assertPixelBudget(source.width, source.height);

    const target = fitWithin(source.width, source.height, MAX_DECODE_SIDE);
    const resize = target.width !== source.width || target.height !== source.height;

    try {
        return await createImageBitmap(
            file,
            resize
                ? {
                      imageOrientation: 'from-image',
                      resizeWidth: target.width,
                      resizeHeight: target.height,
                      resizeQuality: 'high',
                  }
                : { imageOrientation: 'from-image' }
        );
    } catch {
        throw new AvatarImageError('That image could not be read. Try a JPEG, PNG or WebP file.');
    }
}

/** Paint `bitmap` as seen through the crop frame onto `ctx`, an `out`-pixel square. */
export function paintCrop(
    ctx: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    state: CropState,
    frame: number,
    out: number
): void {
    const { width, height } = bitmap;
    const oriented = orientedSize(width, height, state.rotation);
    const t = viewTransform(state, width, height, frame, out);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, out, out);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(t.scale, 0, 0, t.scale, t.tx, t.ty);
    ctx.translate(oriented.width / 2, oriented.height / 2);
    ctx.rotate((state.rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -width / 2, -height / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Render the crop to a square WebP (PNG where the browser cannot encode WebP) of `size` pixels.
 * The server accepts both and sniffs the real type, so the file is named for what it really is.
 */
export async function renderAvatarFile(
    bitmap: ImageBitmap,
    state: CropState,
    frame: number,
    requestedSize = OUTPUT_SIZE
): Promise<File> {
    const size = clampOutputSize(requestedSize);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new AvatarImageError('Your browser could not prepare the image.');
    }
    paintCrop(ctx, bitmap, state, frame, size);

    let blob: Blob | null = null;
    for (const quality of [0.9, 0.8, 0.65]) {
        blob = await toBlob(canvas, 'image/webp', quality);
        if (!blob || blob.type !== 'image/webp' || blob.size <= MAX_OUTPUT_BYTES) {
            break;
        }
    }
    if (!blob || blob.type !== 'image/webp') {
        blob = await toBlob(canvas, 'image/png');
    }
    if (!blob) {
        throw new AvatarImageError('Your browser could not prepare the image.');
    }
    if (blob.size > MAX_OUTPUT_BYTES) {
        throw new AvatarImageError('The result is still too large. Try a simpler picture.');
    }

    const extension = blob.type === 'image/webp' ? 'webp' : 'png';
    return new File([blob], `avatar.${extension}`, { type: blob.type });
}
