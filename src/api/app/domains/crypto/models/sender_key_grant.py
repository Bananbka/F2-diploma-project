import uuid
from datetime import datetime

from sqlalchemy import Text, DateTime, ForeignKey, func, Index, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.postgres import Base


class SenderKeyGrant(Base):
    """One sender's chain key, wrapped to one recipient device.

    This is the table that grows quadratically: S senders x (N-1) recipients per epoch. The cost is
    paid lazily by each sender rather than synchronously by whoever triggered the rotation, which
    is what keeps rotation from blocking — but it is also why encrypted groups need a member cap
    and why broadcast channels cannot use this scheme at all.

    A pruning job can delete grants for closed epochs once every recipient has fetched them; a
    client that lost its private key could not decrypt them anyway. Distributions must never be
    pruned, since they hold the signing keys needed to verify historical messages.
    """
    __tablename__ = "sender_key_grants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    distribution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sender_key_distributions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), nullable=False
    )

    recipient_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    recipient_device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_devices.id", ondelete="CASCADE"), nullable=False
    )
    # Which identity key version this was wrapped to. Lets a client notice a grant is stale after
    # the recipient rotated identity and request a re-wrap, instead of failing silently.
    recipient_identity_key_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_identity_keys.id", ondelete="CASCADE"), nullable=False
    )

    # The chain owner normally, or a forwarding member when backfilling history for a new joiner.
    granted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    wrap_algorithm: Mapped[str] = mapped_column(Text, nullable=False)
    ephemeral_public_key: Mapped[str] = mapped_column(Text, nullable=False)
    wrapped_chain_key: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    distribution = relationship("SenderKeyDistribution")

    __table_args__ = (
        UniqueConstraint(
            "distribution_id", "recipient_device_id", name="uq_grant_distribution_recipient"
        ),
        # The hot read: "every grant addressed to me in this chat".
        Index("ix_grant_chat_recipient", "chat_id", "recipient_device_id"),
    )
