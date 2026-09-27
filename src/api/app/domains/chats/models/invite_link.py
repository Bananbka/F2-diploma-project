import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.postgres import Base


class ChatInviteLink(Base):
    """An open-enrollment join credential for one group or channel.

    `token` is the entire security boundary: anyone holding it can join the chat (subject to
    expiry/use-count/revocation and the encrypted-group member cap), so it is generated with
    `secrets.token_urlsafe` — a CSPRNG — never `random`, and is never logged or included in the
    audit trail (see `app/core/audit.py`'s "metadata only" rule; only this link's `id` is audited,
    not `token`).

    Deliberately has no relationship to `ParticipantRole` beyond who is *allowed to create/revoke*
    one (checked in the router via `chat_services.role_rank`, the same gate pinning uses) — the
    link itself carries no role, and everyone who joins through it lands as a plain MEMBER, same
    as `add_chat_participants`.
    """

    __tablename__ = "chat_invite_links"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # 32 bytes of `secrets.token_urlsafe` renders to ~43 base64url characters; sized generously
    # above that so a future move to a longer token never needs a migration.
    token: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # NULL means unlimited. Enforced with an atomic `UPDATE ... WHERE use_count < max_uses`
    # (see `invite_link_services._consume`) rather than read-then-write, so two joins racing on
    # a link with exactly one use left cannot both succeed.
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    use_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    chat = relationship("Chat")
