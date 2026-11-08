"""Validation of an uploaded chat-background image, by header parsing (no image library).

The type is decided by magic bytes and the dimensions are read from the header, so nothing is ever
decoded here: a decompression bomb is rejected on its declared size before any decoder sees it.
"""

import hashlib
import struct

MAX_BACKGROUND_BYTES = 5 * 1024 * 1024
MAX_SIDE = 8000
MAX_PIXELS = 40_000_000

PNG_SIG = b"\x89PNG\r\n\x1a\n"


class InvalidImage(ValueError):
    """The bytes are not an acceptable JPEG, PNG or WebP."""


def _png_size(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise InvalidImage("Malformed PNG.")
    return struct.unpack(">II", data[16:24])


def _jpeg_size(data: bytes) -> tuple[int, int]:
    i, n = 2, len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            raise InvalidImage("Malformed JPEG.")
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0x01, *range(0xD0, 0xDA)):  # standalone markers, no length
            i += 2
            continue
        (length,) = struct.unpack(">H", data[i + 2 : i + 4])
        if marker in range(0xC0, 0xD0) and marker not in (0xC4, 0xC8, 0xCC):
            if i + 9 > n:
                break
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            return width, height
        if marker == 0xDA:  # start of scan reached without a frame header
            break
        i += 2 + length
    raise InvalidImage("Malformed JPEG.")


def _webp_size(data: bytes) -> tuple[int, int]:
    fourcc = data[12:16]
    chunk = data[20:30]
    if fourcc == b"VP8X" and len(chunk) >= 10:
        return (
            int.from_bytes(chunk[4:7], "little") + 1,
            int.from_bytes(chunk[7:10], "little") + 1,
        )
    if fourcc == b"VP8L" and len(chunk) >= 5 and chunk[0] == 0x2F:
        bits = int.from_bytes(chunk[1:5], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if fourcc == b"VP8 " and len(chunk) >= 10 and chunk[3:6] == b"\x9d\x01\x2a":
        return (
            int.from_bytes(chunk[6:8], "little") & 0x3FFF,
            int.from_bytes(chunk[8:10], "little") & 0x3FFF,
        )
    raise InvalidImage("Malformed WebP.")


def inspect(data: bytes) -> tuple[str, str]:
    """Return `(content_type, version)` or raise `InvalidImage`.

    `version` is a short content hash, used as the ETag and cache-busting key.
    """
    if data.startswith(PNG_SIG):
        content_type, (width, height) = "image/png", _png_size(data)
    elif data.startswith(b"\xff\xd8\xff"):
        content_type, (width, height) = "image/jpeg", _jpeg_size(data)
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        content_type, (width, height) = "image/webp", _webp_size(data)
    else:
        raise InvalidImage("Only JPEG, PNG and WebP images are accepted.")

    if width < 1 or height < 1:
        raise InvalidImage("Image has no pixels.")
    if width > MAX_SIDE or height > MAX_SIDE or width * height > MAX_PIXELS:
        raise InvalidImage(f"Image dimensions exceed {MAX_SIDE}px per side.")

    return content_type, hashlib.sha256(data).hexdigest()[:16]
