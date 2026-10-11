import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, PrimaryKeyConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.postgres import Base


class StickerPackSubscription(Base):
    """A user's "added to my tray" relation to a public pack.

    No sticker data is copied — this is purely a membership row. The pack owner's own pack is
    implicitly in their tray, so the owner never needs a row here.
    """
    __tablename__ = "sticker_pack_subscriptions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    pack_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sticker_packs.id", ondelete="CASCADE"), nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("user_id", "pack_id"),
    )
