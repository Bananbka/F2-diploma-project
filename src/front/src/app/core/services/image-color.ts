/**
 * The average colour of RGBA pixel data as `#rrggbb`, ignoring (mostly) transparent pixels.
 * Null when there is nothing opaque to average. Pure, so it can be tested without a canvas.
 */
export function averageColorOfPixels(data: ArrayLike<number>): string | null {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
        if (data[i + 3] < 128) {
            continue;
        }
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
    }
    if (count === 0) {
        return null;
    }
    const hex = (n: number): string =>
        Math.round(n / count)
            .toString(16)
            .padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const SAMPLE_SIZE = 16;

/** Draw the image onto a tiny offscreen canvas and average it. Null if it cannot be read. */
export async function sampleImageColor(url: string): Promise<string | null> {
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            return null;
        }
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        return averageColorOfPixels(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
    } catch {
        return null;
    }
}
