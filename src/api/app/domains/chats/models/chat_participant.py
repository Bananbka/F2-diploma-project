import enum
import uuid

from sqlalchemy import UUID, ForeignKey, Enum, DateTime, func, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.postgres import Base


class ParticipantRole(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"


class ChatParticipant(Base):
    __tablename__ = 'chat_participants'

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False)

    chat_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    role: Mapped[ParticipantRole] = mapped_column(Enum(ParticipantRole), default=ParticipantRole.MEMBER, nullable=False)

    muted_until: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    joined_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    last_read_message_id = mapped_column(String, nullable=True)

    # Epoch this participant joined at. Under HistoryVisibility.JOINED they receive grants only
    # from here onward.
    joined_at_epoch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # ObjectId of the newest message at join time, used to floor history reads.
    #
    # This is defence in depth, NOT the security boundary — the real boundary is that no grant
    # exists for earlier epochs. It matters because without it a joiner still receives every
    # historical ciphertext: unreadable, but leaking sender, timing, size and reply structure for
    # the entire history. Stored explicitly rather than derived from joined_at, which is only
    # second-granular and would include or exclude boundary messages arbitrarily.
    history_start_message_id: Mapped[str | None] = mapped_column(String, nullable=True)

    chat = relationship("Chat", back_populates="participants")
    user = relationship("User", back_populates="chats")

    __table_args__ = (
        UniqueConstraint('chat_id', 'user_id', name='uq_chat_user'),
    )
