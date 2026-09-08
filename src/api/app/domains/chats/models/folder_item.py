import uuid

from sqlalchemy import ForeignKey
from sqlalchemy.orm import Mapped, relationship
from sqlalchemy.testing.schema import mapped_column

from app.infrastructure.postgres import Base


class FolderItem(Base):
    __tablename__ = "folder_items"

    folder_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("chat_folders.id", ondelete="CASCADE"), primary_key=True)
    chat_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), primary_key=True)

    folder = relationship("ChatFolder", back_populates="items")
