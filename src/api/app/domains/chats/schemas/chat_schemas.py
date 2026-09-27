import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.config import settings
from app.domains.chats.models import ChatType, ParticipantRole


def _validate_avatar_url(v: str | None) -> str | None:
    """Anchor an avatar url to the configured avatar bucket, the same way `Attachment.url` is
    anchored to the message bucket in `messages_schemas.py`.

    Not exploitable today — the CSP's `img-src 'self' data:` blocks any external image load — but
    an arbitrary string here is still an unvalidated field a future consumer (or a relaxed CSP)
    could turn into an open redirect or SSRF-adjacent surface. Anchoring costs nothing.
    """
    if v is None:
        return v

    prefix = f"{settings.MINIO_URL}/{settings.MINIO_AVATAR_BUCKET}/"
    if not v.startswith(prefix):
        raise ValueError("avatar_url must point at the avatar bucket.")

    object_key = v[len(prefix):]
    if not object_key or "/" in object_key:
        raise ValueError("avatar_url must reference a single object key.")

    return v


class PrivateChatCreateRequest(BaseModel):
    target_user_id: uuid.UUID


class GroupChatCreateRequest(BaseModel):
    # Bounded like the channel request below. Unbounded, one request could store as much text as
    # the body allowed in a `Text` column, and add an unlimited number of participants.
    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = Field(None, max_length=2000)
    avatar_url: str | None = Field(None, max_length=1024)
    participant_ids: list[uuid.UUID] = Field(default_factory=list, max_length=256)

    @field_validator("avatar_url")
    @classmethod
    def _v_avatar_url(cls, v: str | None) -> str | None:
        return _validate_avatar_url(v)


class ChatParticipantResponse(BaseModel):
    user_id: uuid.UUID
    role: ParticipantRole
    joined_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatResponse(BaseModel):
    id: uuid.UUID
    chat_type: ChatType

    title: str | None = None
    avatar_url: str | None = None

    unread_count: int = 0
    last_message: Any = None

    created_at: datetime
    updated_at: datetime | None = None

    participants: list[ChatParticipantResponse] = []

    model_config = ConfigDict(from_attributes=True)


class ChannelCreateRequest(BaseModel):
    """Create a broadcast channel.

    Channels are authenticated but not encrypted: posts carry an Ed25519 signature so subscribers
    can verify authorship, while the content itself is readable by the server. Confidentiality is
    unachievable for open-enrollment broadcast anyway, and sender-key distribution does not scale
    to channel-sized membership.
    """

    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = Field(None, max_length=2000)
    avatar_url: str | None = Field(None, max_length=1024)
    subscriber_ids: list[uuid.UUID] = Field(default_factory=list, max_length=1024)

    @field_validator("avatar_url")
    @classmethod
    def _v_avatar_url(cls, v: str | None) -> str | None:
        return _validate_avatar_url(v)


class UserListRequest(BaseModel):
    # Bounded at both ends. An empty list reached `insert().values([])`, which is a SQL syntax
    # error and surfaced as a 500 rather than a validation message.
    user_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=256)


class ChangeRoleRequest(BaseModel):
    user_id: uuid.UUID
    role: ParticipantRole


class TransferOwnershipRequest(BaseModel):
    """Hand OWNER to another member. The current owner is demoted to ADMIN."""

    user_id: uuid.UUID
