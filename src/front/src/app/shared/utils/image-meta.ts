/** What a picture really is, from its first bytes. Null when it is not a format we know. */
export function sniffImageType(bytes: Uint8Array): string | null {
    const startsWith = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
    if (startsWith(0x89, 0x50, 0x4e, 0x47)) {
        return 'image/png';
    }
    if (startsWith(0xff, 0xd8, 0xff)) {
        return 'image/jpeg';
    }
    if (startsWith(0x47, 0x49, 0x46, 0x38)) {
        return 'image/gif';
    }
    // RIFF....WEBP
    if (
        startsWith(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

const EXTENSION_TYPES: Record<string, string> = {
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
};

export function mimeFromName(name: string): string | null {
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
    return (ext && EXTENSION_TYPES[ext]) || null;
}

/**
 * The best-known type of a picture. A generic or missing declared type ("application/octet-stream",
 * which is what an encrypted upload is recorded as) is not trusted: the bytes win, then the file name.
 */
export function resolveImageType(declared: string | undefined, name: string, bytes?: Uint8Array): string | null {
    const sniffed = bytes ? sniffImageType(bytes) : null;
    if (sniffed) {
        return sniffed;
    }
    if (declared && /^image\//i.test(declared)) {
        return declared.toLowerCase();
    }
    return mimeFromName(name);
}

/** PNG, WebP and GIF can contain transparent pixels. */
export function typeMayBeTransparent(type: string | null): boolean {
    return type !== null && /^image\/(png|webp|gif)$/i.test(type);
}

/** The natural pixel size of a picture or video before it is encrypted, so recipients can reserve its box. */
export async function readMediaSize(file: File): Promise<{ width: number; height: number } | null> {
    const url = URL.createObjectURL(file);
    try {
        if (file.type.startsWith('video/')) {
            return await new Promise((resolve) => {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () =>
                    resolve(
                        video.videoWidth && video.videoHeight
                            ? { width: video.videoWidth, height: video.videoHeight }
                            : null
                    );
                video.onerror = () => resolve(null);
                video.src = url;
            });
        }
        const image = new Image();
        image.src = url;
        await image.decode();
        return image.naturalWidth && image.naturalHeight
            ? { width: image.naturalWidth, height: image.naturalHeight }
            : null;
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(url);
    }
}
