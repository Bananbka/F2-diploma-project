import uuid
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class WSEventType(str, Enum):
    NEW_MESSAGE = "new_message"
    MESSAGE_EDITED = "message_edited"
    MESSAGE_DELETED = "message_deleted"
    TYPING_START = "typing_start"
    TYPING_STOP = "typing_stop"
    MESSAGE_READ = "message_read"
    USER_OFFLINE = "user_offline"
    USER_ONLINE = "user_online"
    CHAT_CREATED = "chat_created"
    # Membership and lifecycle. None of these existed, so a member removed from a group was never
    # told: their client kept the conversation on screen, and only a manual refresh revealed it
    # was gone. CHAT_DELETED doubles as "this chat is no longer yours" for a removed member.
    CHAT_UPDATED = "chat_updated"
    CHAT_DELETED = "chat_deleted"
    PARTICIPANTS_ADDED = "participants_added"
    PARTICIPANTS_REMOVED = "participants_removed"
    # A new key epoch opened. Clients should publish a sender key before their next send, and
    # fetch grants so they can read what others send under it.
    KEY_EPOCH_STARTED = "key_epoch_started"
    # Reactions and pins are chat-scoped, so every member is notified, unlike mute which is
    # per-user local state and never broadcast.
    MESSAGE_REACTION_ADDED = "message_reaction_added"
    MESSAGE_REACTION_REMOVED = "message_reaction_removed"
    MESSAGE_PINNED = "message_pinned"
    MESSAGE_UNPINNED = "message_unpinned"
    ERROR = "error"


class WSMessageEnvelope(BaseModel):
    event_type: WSEventType
    chat_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    model_config = {
        "use_enum_values": True,
    }
