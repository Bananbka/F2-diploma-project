import datetime
import enum
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.core.config import settings


class Attachment(BaseModel):
    """A message attachment.

    `url` is validated to be a single object key inside the message bucket, OR inside the
    sticker bucket when `kind == 'sticker'` — a sticker is a public asset belonging to some pack,
    never something "uploaded" into the message bucket by the sender. Without this the value is
    entirely client-controlled and flows into MinIO deletion in `delete_message`, which would let
    a user delete arbitrary objects belonging to other users.

    `kind` and the matched bucket are cross-checked by `_check_kind_matches_bucket` below so the
    two fields can never disagree: `kind == 'sticker'` with a message-bucket url (or vice versa)
    was exactly how a sender could claim `kind: 'sticker'` to skip `_authorize_attachments`'s
    ownership/visibility check while actually naming a private message-bucket object. The service
    layer now also derives the sticker exemption from the URL itself rather than trusting `kind`,
    but this keeps the two fields from being able to lie to each other in the first place.
    """
    url: str = Field(..., max_length=512)
    name: str = Field(..., max_length=255)
    size: int = Field(..., ge=0)
    content_type: str = Field(..., max_length=255)

    # Media metadata, all client-supplied and optional — the server never inspects attachment
    # bytes (they are opaque, client-encrypted blobs; see docs/crypto-spec-v1.md), so none of
    # this is verified, only carried through for rendering.
    kind: Literal['file', 'image', 'video', 'gif', 'audio', 'sticker'] = 'file'
    duration_ms: int | None = Field(None, ge=0)
    width: int | None = Field(None, ge=0)
    height: int | None = Field(None, ge=0)
    waveform: list[float] | None = Field(None, max_length=64)

    @field_validator('url')
    @classmethod
    def validate_url(cls, v: str) -> str:
        message_prefix = f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/"
        # Stickers are uploaded to a public bucket, so their stored url is built from
        # MINIO_PUBLIC_URL (see MinioClient.upload_file), not the internal MINIO_URL used for the
        # message bucket.
        sticker_prefix = f"{settings.MINIO_PUBLIC_URL}/{settings.MINIO_STICKER_BUCKET}/"

        for prefix in (message_prefix, sticker_prefix):
            if v.startswith(prefix):
                object_key = v[len(prefix):]
                if not object_key or "/" in object_key:
                    raise ValueError('Attachment url must reference a single object key.')
                return v

        raise ValueError(
            'Attachment url must point at the message attachments bucket or the sticker bucket.'
        )

    @model_validator(mode="after")
    def _check_kind_matches_bucket(self) -> "Attachment":
        sticker_prefix = f"{settings.MINIO_PUBLIC_URL}/{settings.MINIO_STICKER_BUCKET}/"
        is_sticker_bucket_url = self.url.startswith(sticker_prefix)
        is_sticker_kind = self.kind == "sticker"

        if is_sticker_kind and not is_sticker_bucket_url:
            raise ValueError(
                "An attachment with kind 'sticker' must point at the sticker bucket."
            )
        if is_sticker_bucket_url and not is_sticker_kind:
            raise ValueError(
                "An attachment pointing at the sticker bucket must have kind 'sticker'."
            )

        return self


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
    # ciphertext || GCM tag, b64u. ~190 KB of plaintext; attachments travel as separate blobs.
    ct: str = Field(..., max_length=256_000)
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


class Reaction(BaseModel):
    """One user's reaction to a message.

    A user may hold at most one reaction per emoji on a message (adding the same emoji twice is a
    toggle-off, handled in `messages_service.toggle_reaction`), but may hold several *different*
    emojis on the same message at once — matching the common messenger convention (Telegram,
    Discord) rather than the single-reaction-slot model some clients use.
    """
    user_id: uuid.UUID
    emoji: str
    created_at: datetime.datetime


def validate_emoji(v: str) -> str:
    """Basic emoji sanity check, not a full grapheme-cluster validator.

    Rejects the empty string and anything ASCII-only (plain text such as "lol" or ":)"), which
    catches the obvious misuse without trying to enumerate every valid emoji code point — Unicode
    keycap sequences, skin-tone modifiers and ZWJ sequences all contain at least one non-ASCII
    code point, so the heuristic does not reject them.
    """
    v = v.strip()
    if not v:
        raise ValueError("emoji must not be empty")
    if v.isascii():
        raise ValueError("emoji must be an actual emoji, not plain text")
    return v


class ReactionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    emoji: str = Field(..., min_length=1, max_length=8)

    @field_validator("emoji")
    @classmethod
    def _validate_emoji(cls, v: str) -> str:
        return validate_emoji(v)


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

    attachments: list[Attachment] | None = None

    # Idempotency key chosen by the sender, unique per (chat, sender); see `ux_chat_sender_client_msg`.
    client_message_id: uuid.UUID | None = None

    reactions: list[Reaction] = Field(default_factory=list)

    # DEPRECATED: a single shared boolean, so one member reading a group message marks it read for
    # every other member too. Kept (and still written by `mark_messages_as_read`) only for
    # backward compatibility with any client still reading it; per-user read state is now the
    # `last_read_message_id` on each `ChatParticipant`, exposed via `GET /chats/{id}/read-state`
    # and `chat_services.get_chat_read_state`. Do not add new logic that treats this as
    # authoritative.
    is_read: bool = False
    is_pinned: bool = False
    pinned_at: datetime.datetime | None = None
    pinned_by: uuid.UUID | None = None
    is_edited: bool = False
    edited_at: datetime.datetime | None = None

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

    attachments: list[Attachment] | None = None
    client_message_id: uuid.UUID | None = None

    reactions: list[Reaction] = Field(default_factory=list)

    # DEPRECATED: see the identical note on `MessageDocument.is_read`. Retained for API
    # compatibility; not the source of truth for read state any more.
    is_read: bool = False
    is_pinned: bool = False
    pinned_at: datetime.datetime | None = None
    pinned_by: uuid.UUID | None = None
    is_edited: bool = False
    edited_at: datetime.datetime | None = None

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    @field_validator("edited_at")
    @classmethod
    def _edited_at_is_utc(cls, v: datetime.datetime | None) -> datetime.datetime | None:
        """Mongo returns naive datetimes; they are UTC, so say so on the wire."""
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=datetime.timezone.utc)
        return v

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

    `client_message_id` makes a send idempotent: repeating the same (chat, sender, id) returns the
    already-stored message instead of creating a second one.
    """
    model_config = ConfigDict(extra="forbid")

    chat_id: uuid.UUID
    client_message_id: uuid.UUID | None = None

    encrypted_content: str | None = Field(None, max_length=64_000)
    envelope: MessageEnvelope | None = None
    channel_post: ChannelPost | None = None

    reply_to_message_id: str | None = Field(None, max_length=24)
    # Client-supplied and unverifiable — see ForwardOrigin. Stored as given so the receiving client
    # can attribute the copy; the server has no way to confirm it and does not pretend to.
    forwarded_from: ForwardOrigin | None = None
    attachments: list[Attachment] | None = Field(default=None, max_length=10)

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
    model_config = ConfigDict(extra="forbid")

    encrypted_content: str | None = Field(None, max_length=64_000)
    envelope: MessageEnvelope | None = None

    # Omitted (field absent from the request body) means "leave the existing attachments alone".
    # Explicitly supplying either `[]` or `null` means "remove every attachment" — the two are
    # treated as the same request, since both are just ways of saying "no attachments", and unlike
    # `PATCH /profile/me` there is no NOT-NULL column an empty list would violate. `update_message`
    # distinguishes "omitted" from "explicitly supplied" via `"attachments" in
    # message_in.model_fields_set`, not by this field's default alone.
    attachments: list[Attachment] | None = Field(default=None, max_length=10)

    @model_validator(mode="after")
    def check_exactly_one_content(self):
        if (self.envelope is None) == (self.encrypted_content is None):
            raise ValueError("provide exactly one of 'envelope' or 'encrypted_content'")
        return self
