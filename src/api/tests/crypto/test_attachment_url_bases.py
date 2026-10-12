"""Pure schema-level tests for the public/internal url-base split.

Avatars and stickers are public-bucket images rendered directly as `<img src>`, so their stored
url must be anchored to MINIO_PUBLIC_URL (the browser-reachable base) rather than MINIO_URL (the
Docker-internal hostname the API's S3 client uses to reach the store). Message-bucket attachments
are never rendered as a raw url, so they stay anchored to MINIO_URL. No HTTP or DB needed — this
exercises `Attachment` and `StickerCreateRequest` directly.
"""

import pytest
from pydantic import ValidationError

from app.core.config import settings
from app.domains.messages.schemas.messages_schemas import Attachment
from app.domains.stickers.schemas.sticker_schemas import StickerCreateRequest

PUBLIC_STICKER_URL = f"{settings.MINIO_PUBLIC_URL}/{settings.MINIO_STICKER_BUCKET}/some-key"
INTERNAL_STICKER_URL = f"{settings.MINIO_URL}/{settings.MINIO_STICKER_BUCKET}/some-key"
INTERNAL_MESSAGE_URL = f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/some-key"


def test_attachment_accepts_a_public_prefixed_sticker_url():
    attachment = Attachment(
        url=PUBLIC_STICKER_URL,
        name="n",
        size=1,
        content_type="image/png",
        kind="sticker",
    )
    assert attachment.url == PUBLIC_STICKER_URL


def test_attachment_rejects_the_old_internal_prefixed_sticker_url():
    """Before the public-base split, a sticker url was built from MINIO_URL. That shape must no
    longer validate — otherwise a stale/forged internal-prefixed url could still pass."""
    with pytest.raises(ValidationError):
        Attachment(
            url=INTERNAL_STICKER_URL,
            name="n",
            size=1,
            content_type="image/png",
            kind="sticker",
        )


def test_attachment_accepts_an_internal_prefixed_message_url():
    attachment = Attachment(
        url=INTERNAL_MESSAGE_URL,
        name="n",
        size=1,
        content_type="application/octet-stream",
        kind="file",
    )
    assert attachment.url == INTERNAL_MESSAGE_URL


def test_sticker_create_request_accepts_a_public_prefixed_url():
    req = StickerCreateRequest(image_url=PUBLIC_STICKER_URL, emoji="\U0001F600")
    assert req.image_url == PUBLIC_STICKER_URL


def test_sticker_create_request_rejects_the_old_internal_prefixed_url():
    with pytest.raises(ValidationError):
        StickerCreateRequest(image_url=INTERNAL_STICKER_URL, emoji="\U0001F600")
