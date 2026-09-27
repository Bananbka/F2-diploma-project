import uuid
from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.domains.chats.models import ChatType


class CreateInviteLinkRequest(BaseModel):
    """Both bounds are optional. Omitting both creates a link with no expiry and no use cap —
    allowed, since revocation is always available as the way to close it."""

    expires_at: datetime | None = None
    # Bounded well above anything a real chat would need, purely to keep the column away from
    # absurd values rather than because a legitimate use case needs a five-figure cap.
    max_uses: int | None = Field(None, ge=1, le=100_000)


class InviteLinkResponse(BaseModel):
    id: uuid.UUID
    chat_id: uuid.UUID
    token: str
    created_by: uuid.UUID | None
    created_at: datetime
    expires_at: datetime | None
    max_uses: int | None
    use_count: int
    revoked_at: datetime | None

    model_config = ConfigDict(from_attributes=True)

    @computed_field
    @property
    def is_active(self) -> bool:
        if self.revoked_at is not None:
            return False
        if self.expires_at is not None and self.expires_at <= datetime.now(timezone.utc):
            return False
        if self.max_uses is not None and self.use_count >= self.max_uses:
            return False
        return True


class InviteLinkPreviewResponse(BaseModel):
    """What an authenticated non-member sees before deciding to join.

    Deliberately narrow: title, avatar, chat type and a member *count* — never the roster. The
    full participant list is a materially bigger disclosure than "this link leads to a group of
    12 people called X", and nothing about deciding whether to join requires it.
    """

    chat_id: uuid.UUID
    chat_type: ChatType
    title: str | None
    avatar_url: str | None
    member_count: int

    model_config = ConfigDict(from_attributes=True)


class InviteLinkJoinResponse(BaseModel):
    chat_id: uuid.UUID
    already_member: bool
