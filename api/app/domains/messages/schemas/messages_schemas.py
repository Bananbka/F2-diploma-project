import datetime
import enum
import uuid

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.core.config import settings


class Attachment(BaseModel):
    """A message attachment.

    `url` is validated to be a single object key inside the message bucket. Without this the
    value is entirely client-controlled and flows into MinIO deletion in `delete_message`,
    which would let a user delete arbitrary objects belonging to other users.
    """
    url: str
    name: str = Field(..., max_length=255)
    size: int = Field(..., ge=0)
    content_type: str = Field(..., max_length=255)

    @field_validator('url')
    @classmethod
    def validate_url(cls, v: str) -> str:
        prefix = f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/"
        if not v.startswith(prefix):
            raise ValueError('Attachment url must point at the message attachments bucket.')

        object_key = v[len(prefix):]
        if not object_key or "/" in object_key:
            raise ValueError('Attachment url must reference a single object key.')

        return v


class ContentFormat(str, enum.Enum):
    """How a message's content is encoded.

    Persisted on the document rather than derived at read time. The previous `is_encrypted` bool
    was computed independently on the send and read paths and the two disagreed — the send path
    silently dropped it and always reported True.
    """
    LEGACY_PLAINTEXT = "legacy_plaintext"       # group/channel messages from before encryption
    LEGACY_RSA = "legacy_rsa"                   # private chats under the old RSA scheme
    SENDER_KEYS_V1 = "sender_keys_v1"           # current: envelope + sender-key ratchet
    CHANNEL_SIGNED_V1 = "channel_signed_v1"     # broadcast: authenticated, deliberately readable

    @property
    def is_encrypted(self) -> bool:
        return self in (ContentFormat.LEGACY_RSA, ContentFormat.SENDER_KEYS_V1)

    @property
    def is_authenticated(self) -> bool:
        """Whether the sender is cryptographically proven, independent of confidentiality."""
        return self in (ContentFormat.SENDER_KEYS_V1, ContentFormat.CHANNEL_SIGNED_V1)


class MessageEnvelope(BaseModel):
    """Sealed message content. See app/domains/crypto/reference/envelope.py for the format.

    chat_id and sender_id are deliberately absent: they are bound into the AAD but taken from the
    request path and the JWT, never from client-supplied envelope fields.
    """
    v: int = Field(1, ge=1)
    alg: str = Field(..., max_length=32)
    epoch: int = Field(..., ge=0)
    skid: uuid.UUID                     # sender_key_id
    idx: int = Field(..., ge=0)         # chain index
    n: str = Field(..., max_length=32)  # nonce, b64u
    ct: str                             # ciphertext || GCM tag, b64u
    sig: str = Field(..., max_length=128)  # Ed25519, b64u


class ChannelPost(BaseModel):
    """A broadcast post: plaintext content plus an Ed25519 signature over it.

    Not encrypted, by design — see app/domains/crypto/reference/channel.py. Subscribers verify the
    signature to know the post genuinely came from the channel owner.
    """
    v: int = Field(1, ge=1)
    alg: str = Field("ed25519-post-v1", max_length=32)
    post_id: uuid.UUID
    content: str = Field(..., max_length=64_000)
    sig: str = Field(..., max_length=128)


class ForwardOrigin(BaseModel):
    """Who wrote a forwarded message originally, and when.

    Structured rather than prefixed into the plaintext: a prefix cannot be styled apart from the
    message, cannot be resolved to a current display name, and accumulates on every re-forward.

    The server **cannot verify any of this**. A forward under E2E is a re-send — the copy is sealed
    and signed by the forwarder, so this is the forwarder's claim about provenance, not an
    attestation. Clients must present it as attribution and must never let it produce a verified
    marker. Carrying the original author's signature would require re-sealing their envelope, which
    only they could do.
    """
    user_id: uuid.UUID
    created_at: datetime.datetime


class MessageDocument(BaseModel):
    chat_id: uuid.UUID
    sender_id: uuid.UUID

    # Exactly one of these carries the content, selected by content_format.
    encrypted_content: str | None = None
    envelope: MessageEnvelope | None = None
    channel_post: ChannelPost | None = None
    content_format: ContentFormat = ContentFormat.LEGACY_PLAINTEXT

    reply_to_message_id: str | None = None
    forwarded_from: ForwardOrigin | None = None

    attachments: list[dict] | None = None

    is_read: bool = False
    is_pinned: bool = False
    is_edited: bool = False

    created_at: datetime.datetime


class MessageResponse(BaseModel):
    id: str = Field(alias="_id")
    chat_id: uuid.UUID
    sender_id: uuid.UUID

    encrypted_content: str | None = None
    envelope: MessageEnvelope | None = None
    channel_post: ChannelPost | None = None
    content_format: ContentFormat = ContentFormat.LEGACY_PLAINTEXT

    reply_to_message_id: str | None = None
    forwarded_from: ForwardOrigin | None = None
    created_at: datetime.datetime

    attachments: list[dict] | None = None

    is_read: bool = False
    is_pinned: bool = False
    is_edited: bool = False

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    @computed_field
    @property
    def is_encrypted(self) -> bool:
        """Retained for API compatibility, now derived from the persisted format rather than
        recomputed from chat_type on each path."""
        return self.content_format.is_encrypted


class MessageCreateRequest(BaseModel):
    """Send a message.

    Supply exactly one content form: `envelope` for an encrypted chat, `channel_post` for a
    broadcast channel, or `encrypted_content` for a legacy unencrypted chat.
    """
    chat_id: uuid.UUID

    encrypted_content: str | None = None
    envelope: MessageEnvelope | None = None
    channel_post: ChannelPost | None = None

    reply_to_message_id: str | None = None
    # Client-supplied and unverifiable — see ForwardOrigin. Stored as given so the receiving client
    # can attribute the copy; the server has no way to confirm it and does not pretend to.
    forwarded_from: ForwardOrigin | None = None
    attachments: list[Attachment] | None = None

    @model_validator(mode="after")
    def check_exactly_one_content(self):
        supplied = [
            f for f in (self.envelope, self.channel_post, self.encrypted_content) if f is not None
        ]
        if len(supplied) != 1:
            raise ValueError(
                "provide exactly one of 'envelope', 'channel_post' or 'encrypted_content'"
            )
        return self


class MessageUpdateRequest(BaseModel):
    """Edit a message.

    A v1 edit must never reuse a message key. Re-encrypting under an already-used one would repeat a
    (key, nonce) pair, which is catastrophic for AES-GCM — it leaks the XOR of both plaintexts and can
    expose the authentication subkey.

    A key is identified by (sender_key_id, index), not by index alone: each chain has its own random
    chain key, so the same index under a different chain is a different key. The server therefore
    requires a greater index only when the edit reuses the *same* chain, and accepts any index from a
    new one. Sealing from a fresh chain is the normal case for a client that has reloaded.
    """
    encrypted_content: str | None = None
    envelope: MessageEnvelope | None = None

    @model_validator(mode="after")
    def check_exactly_one_content(self):
        if (self.envelope is None) == (self.encrypted_content is None):
            raise ValueError("provide exactly one of 'envelope' or 'encrypted_content'")
        return self
