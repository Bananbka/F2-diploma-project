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
    """Public key material for one member device, everything needed to wrap a key for it.

    The binding signatures are part of the entry, not an optional extra. A roster without them is
    just a list of keys the server asserts — the client has no way to tell a real key from one the
    server substituted, and it will happily wrap the chain key for whatever it is handed. With them
    the client can check that each X25519 key (and each prekey) is vouched for by the Ed25519
    signing key, which is the key a peer pins out of band via the safety number.
    """
    user_id: uuid.UUID
    device_id: uuid.UUID
    identity_key_id: uuid.UUID
    identity_public_key: str
    signing_public_key: str
    # Ed25519 over DS_IDENTITY_BIND || user_id || device_id || identity_public_key.
    identity_key_signature: str
    signed_prekey_public: str | None = None
    # Ed25519 over DS_PREKEY_BIND || user_id || device_id || signed_prekey_public.
    signed_prekey_signature: str | None = None


class RosterResponse(BaseModel):
    chat_id: uuid.UUID
    current_epoch: int
    # The epoch's *stored* commitment, written when the epoch was allocated — never recomputed
    # from the roster being returned. Recomputing it here made the client's check tautological:
    # it compared the server's hash of a list against its own hash of the same list, which passes
    # for any list the server cares to send, ghost devices and substituted keys included.
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
