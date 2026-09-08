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
    # A new key epoch opened. Clients should publish a sender key before their next send, and
    # fetch grants so they can read what others send under it.
    KEY_EPOCH_STARTED = "key_epoch_started"
    ERROR = "error"


class WSMessageEnvelope(BaseModel):
    event_type: WSEventType
    chat_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    model_config = {
        "use_enum_values": True,
    }
