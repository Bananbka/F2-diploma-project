import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

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

    # Per-user mute state for the calling user. Populated from their `ChatParticipant` row by
    # `get_user_chats`/`enrich_chats_with_mongo_data` for the list endpoint, and attached
    # explicitly by the single-chat `get_chat` route — it is not a property of the chat itself.
    muted_until: datetime | None = None

    created_at: datetime
    updated_at: datetime | None = None

    participants: list[ChatParticipantResponse] = []

    model_config = ConfigDict(from_attributes=True)

    @computed_field
    @property
    def is_muted(self) -> bool:
        return self.muted_until is not None and self.muted_until > datetime.now(timezone.utc)


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


class MuteChatRequest(BaseModel):
    """Mute or unmute this chat for the calling user only.

    There is a single nullable field rather than a separate `muted` bool plus a `muted_until`:
    `muted_until` set to a future timestamp mutes until then, and omitting it (or sending
    `null`) unmutes — no distinct "mute forever" flag exists. A client wanting an indefinite mute
    sends a timestamp far enough in the future; that keeps the server-side state to one column
    with no ambiguity between "not muted" and "muted with no expiry".
    """

    muted_until: datetime | None = None


class MuteChatResponse(BaseModel):
    chat_id: uuid.UUID
    muted_until: datetime | None = None

    model_config = ConfigDict(from_attributes=True)

    @computed_field
    @property
    def is_muted(self) -> bool:
        return self.muted_until is not None and self.muted_until > datetime.now(timezone.utc)
