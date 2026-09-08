import enum
import uuid
from datetime import datetime

from sqlalchemy import Integer, Text, DateTime, Enum, ForeignKey, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.postgres import Base


class CryptoMode(str, enum.Enum):
    LEGACY = "legacy"                    # plaintext, or private chats on the old RSA scheme
    SENDER_KEYS_V1 = "sender_keys_v1"    # end-to-end encrypted
    NOT_ENCRYPTED = "not_encrypted"      # channels: signed for authenticity, not confidential


class HistoryVisibility(str, enum.Enum):
    JOINED = "joined"   # a new member gets grants only from their join epoch onward
    SHARED = "shared"   # existing members backfill grants for earlier epochs


class EpochReason(str, enum.Enum):
    INITIAL = "initial"
    MEMBER_ADDED = "member_added"
    MEMBER_REMOVED = "member_removed"
    DEVICE_REVOKED = "device_revoked"
    PERIODIC = "periodic"
    MANUAL = "manual"


class ChatCryptoSettings(Base):
    """Per-chat encryption configuration.

    Kept in its own table rather than as columns on `chats` so the crypto domain stays
    self-contained and cascades cleanly. Costs one join on the chat read path.
    """
    __tablename__ = "chat_crypto_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True
    )

    crypto_mode: Mapped[CryptoMode] = mapped_column(
        Enum(CryptoMode), default=CryptoMode.LEGACY, nullable=False
    )
    history_visibility: Mapped[HistoryVisibility] = mapped_column(
        Enum(HistoryVisibility), default=HistoryVisibility.JOINED, nullable=False
    )

    current_epoch: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    rotation_interval_days: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    last_rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), onupdate=func.now(), nullable=True
    )

    chat = relationship("Chat")

    __table_args__ = (
        UniqueConstraint("chat_id", name="uq_crypto_settings_chat"),
    )


class ChatKeyEpoch(Base):
    """A keying period for one chat.

    Deliberately carries **no key material** — just an integer and a commitment to the member set.
    That is what lets the server allocate an epoch on its own: rotation never waits for a client to
    come online, and there is no state in which the group is unable to send. A design built around
    one shared epoch key would need a nominated online client to generate it, and would freeze the
    whole chat whenever that client was away.
    """
    __tablename__ = "chat_key_epochs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True
    )
    epoch: Mapped[int] = mapped_column(Integer, nullable=False)

    reason: Mapped[EpochReason] = mapped_column(Enum(EpochReason), nullable=False)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    member_count: Mapped[int] = mapped_column(Integer, nullable=False)
    # SHA-256 over the sorted device set. Clients MUST verify this against the roster before
    # wrapping keys — it is the only defence against a server silently inserting a ghost device.
    member_set_hash: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    chat = relationship("Chat")

    __table_args__ = (
        UniqueConstraint("chat_id", "epoch", name="uq_chat_epoch"),
    )


class SenderKeyDistribution(Base):
    """The public half of one sender's chain for one epoch.

    Created lazily: a member that never sends never publishes one, and never pays the wrapping
    cost. Two senders publishing in the same epoch is normal — the chains are independent, so
    there is no race to resolve.
    """
    __tablename__ = "sender_key_distributions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    epoch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chat_key_epochs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Denormalised: every read path filters by chat first.
    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True
    )

    sender_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_devices.id", ondelete="CASCADE"), nullable=False
    )

    # Opaque handle carried in every message envelope; recipients key their local chain store on it.
    sender_key_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    algorithm: Mapped[str] = mapped_column(Text, nullable=False)
    # Per-chain Ed25519 key. The server uses it to verify message signatures on send.
    signing_public_key: Mapped[str] = mapped_column(Text, nullable=False)
    chain_start_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Signed by the sender's long-term identity key, vouching for signing_public_key.
    signature: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    epoch = relationship("ChatKeyEpoch")

    # Deliberately not unique on (epoch_id, sender_device_id). A device may publish several chains
    # within one epoch, because chain state is secret and memory-only, so a client that reloads has
    # to mint a fresh one. Identity is carried by sender_key_id, and receivers select a chain per
    # message from the envelope's `skid`, so concurrent chains from one sender are already handled.
    __table_args__ = (
        UniqueConstraint("chat_id", "sender_key_id", name="uq_skd_chat_sender_key_id"),
    )
