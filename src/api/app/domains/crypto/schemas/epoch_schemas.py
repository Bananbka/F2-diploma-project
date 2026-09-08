import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.domains.crypto.models import CryptoMode, EpochReason, HistoryVisibility


class EpochResponse(BaseModel):
    id: uuid.UUID
    epoch: int
    reason: EpochReason
    member_count: int
    # Clients MUST recompute this from the roster and refuse to wrap keys on mismatch. It is the
    # only defence against the server silently inserting a ghost device into the member set.
    member_set_hash: str
    created_at: datetime
    closed_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class RosterEntry(BaseModel):
    """Public key material for one member device, everything needed to wrap a key for it."""
    user_id: uuid.UUID
    device_id: uuid.UUID
    identity_key_id: uuid.UUID
    identity_public_key: str
    signing_public_key: str
    signed_prekey_public: str | None = None


class RosterResponse(BaseModel):
    chat_id: uuid.UUID
    current_epoch: int
    member_set_hash: str
    members: list[RosterEntry]


class GrantUpload(BaseModel):
    recipient_device_id: uuid.UUID
    wrap_algorithm: str = Field(..., max_length=64)
    ephemeral_public_key: str
    wrapped_chain_key: str


class SenderKeyUpload(BaseModel):
    """A sender's chain for one epoch, plus one wrapped copy per recipient device."""
    sender_device_id: uuid.UUID
    sender_key_id: uuid.UUID
    algorithm: str = Field(..., max_length=64)
    signing_public_key: str
    chain_start_index: int = Field(0, ge=0)
    signature: str
    grants: list[GrantUpload] = Field(..., min_length=1)


class GrantResponse(BaseModel):
    recipient_device_id: uuid.UUID
    recipient_identity_key_id: uuid.UUID
    wrap_algorithm: str
    ephemeral_public_key: str
    wrapped_chain_key: str


class DistributionResponse(BaseModel):
    distribution_id: uuid.UUID
    epoch: int
    sender_user_id: uuid.UUID
    sender_device_id: uuid.UUID
    sender_key_id: uuid.UUID
    algorithm: str
    signing_public_key: str
    chain_start_index: int
    signature: str
    # null means this sender has not wrapped for the caller's device yet — the client should ask
    # for a grant rather than treat the messages as permanently undecryptable.
    grant: GrantResponse | None = None


class ChatKeysResponse(BaseModel):
    crypto_mode: CryptoMode
    history_visibility: HistoryVisibility
    current_epoch: int
    my_join_epoch: int | None = None
    epochs: list[EpochResponse]
    distributions: list[DistributionResponse]


class SenderKeyPublishedResponse(BaseModel):
    distribution_id: uuid.UUID
    epoch: int
    sender_key_id: uuid.UUID
    grant_count: int
