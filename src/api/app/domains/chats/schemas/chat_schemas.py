import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.domains.chats.models import ParticipantRole, ChatType


class PrivateChatCreateRequest(BaseModel):
    target_user_id: uuid.UUID


class GroupChatCreateRequest(BaseModel):
    title: str
    description: str
    avatar_url: str | None = None
    participant_ids: list[uuid.UUID] = []


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
    description: str | None = None
    avatar_url: str | None = None
    subscriber_ids: list[uuid.UUID] = []


class UserListRequest(BaseModel):
    user_ids: list[uuid.UUID]


class ChangeRoleRequest(BaseModel):
    user_id: uuid.UUID
    role: ParticipantRole
