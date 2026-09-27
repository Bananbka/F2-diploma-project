"""Server-side anchoring of `avatar_url` fields, mirroring `Attachment.url` in
`messages_schemas.py`. Pure schema-level tests: no HTTP or DB needed.
"""

import pytest
from pydantic import ValidationError

from app.core.config import settings
from app.domains.chats.schemas.chat_schemas import (
    ChannelCreateRequest,
    GroupChatCreateRequest,
)
from app.domains.users.schemas.profile_schemas import ProfileRequestSchema

VALID = f"{settings.MINIO_URL}/{settings.MINIO_AVATAR_BUCKET}/some-object-key"


@pytest.mark.parametrize(
    "model, extra_required",
    [
        (GroupChatCreateRequest, {"title": "g"}),
        (ChannelCreateRequest, {"title": "c"}),
    ],
)
def test_valid_avatar_url_is_accepted(model, extra_required):
    obj = model(avatar_url=VALID, **extra_required)
    assert obj.avatar_url == VALID


@pytest.mark.parametrize(
    "model, extra_required",
    [
        (GroupChatCreateRequest, {"title": "g"}),
        (ChannelCreateRequest, {"title": "c"}),
    ],
)
def test_none_avatar_url_is_still_allowed(model, extra_required):
    obj = model(avatar_url=None, **extra_required)
    assert obj.avatar_url is None


@pytest.mark.parametrize(
    "bad_url",
    [
        "https://evil.example.com/image.png",
        f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/some-key",  # wrong bucket
        f"{settings.MINIO_URL}/{settings.MINIO_AVATAR_BUCKET}/",  # empty object key
        f"{settings.MINIO_URL}/{settings.MINIO_AVATAR_BUCKET}/a/../../etc/passwd",  # path traversal
        "javascript:alert(1)",
    ],
)
@pytest.mark.parametrize(
    "model, extra_required",
    [
        (GroupChatCreateRequest, {"title": "g"}),
        (ChannelCreateRequest, {"title": "c"}),
    ],
)
def test_avatar_url_outside_the_bucket_is_rejected(model, extra_required, bad_url):
    with pytest.raises(ValidationError):
        model(avatar_url=bad_url, **extra_required)


def test_profile_avatar_url_accepts_a_bucket_key():
    obj = ProfileRequestSchema(avatar_url=VALID)
    assert obj.avatar_url == VALID


def test_profile_avatar_url_rejects_a_foreign_url():
    with pytest.raises(ValidationError):
        ProfileRequestSchema(avatar_url="https://evil.example.com/x.png")


def test_profile_avatar_url_none_is_still_allowed():
    """Explicit `avatar_url: null` must stay a no-op, not a validation error — only `username`
    and `full_name` have that stricter rule."""
    obj = ProfileRequestSchema(avatar_url=None)
    assert obj.avatar_url is None


def test_channel_description_and_avatar_url_are_bounded():
    with pytest.raises(ValidationError):
        ChannelCreateRequest(title="c", description="x" * 2001)

    with pytest.raises(ValidationError):
        ChannelCreateRequest(title="c", avatar_url="x" * 1025)
