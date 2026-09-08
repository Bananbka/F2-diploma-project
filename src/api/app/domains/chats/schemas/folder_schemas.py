import uuid

from pydantic import BaseModel, ConfigDict


class FolderCreateRequest(BaseModel):
    title: str
    chat_ids: list[uuid.UUID] = []


class FolderUpdateRequest(BaseModel):
    title: str | None = None
    chat_ids: list[uuid.UUID] | None = None


class FolderItemResponse(BaseModel):
    chat_id: uuid.UUID


class FolderResponse(BaseModel):
    id: uuid.UUID
    title: str
    items: list[FolderItemResponse]

    model_config = ConfigDict(from_attributes=True)
