import uuid

from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.postgres import Base


class Sticker(Base):
    """One sticker inside a pack.

    `image_url` is validated at the schema layer (same anchoring-prefix pattern as
    `Attachment.url` / `avatar_url`), not here — models stay free of request-shaped validation.
    """
    __tablename__ = "stickers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    pack_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sticker_packs.id", ondelete="CASCADE"), nullable=False, index=True
    )

    image_url: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    emoji: Mapped[str] = mapped_column(String(8), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    pack = relationship("StickerPack", back_populates="stickers")

    __table_args__ = (
        UniqueConstraint("pack_id", "position", name="uq_stickers_pack_position"),
    )
