import uuid

from pydantic import BaseModel, ConfigDict

from app.domains.users.schemas.user_schemas import UserSearchResponse


class ContactCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_user_id: uuid.UUID
    alias: str | None = None


class ContactResponse(BaseModel):
    owner_id: uuid.UUID
    contact_id: uuid.UUID
    alias_name: str | None = None

    user: UserSearchResponse

    class Config:
        from_attributes = True
