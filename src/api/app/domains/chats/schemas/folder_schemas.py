import uuid

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

# Lucide kebab-case icon name. The server does not know the icon list; the client falls back to a
# default glyph for names it does not recognise.
FolderIcon = Annotated[str, Field(max_length=32, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")]
# Counted in characters (code points), matching Postgres String(64), so emoji titles are accepted.
FolderTitle = Annotated[str, Field(max_length=64)]


class FolderCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: FolderTitle
    icon: FolderIcon | None = None
    chat_ids: list[uuid.UUID] = []


class FolderUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: FolderTitle | None = None
    # Omitted = unchanged; an explicit null clears the icon (the router uses exclude_unset).
    icon: FolderIcon | None = None
    chat_ids: list[uuid.UUID] | None = None


class FolderItemResponse(BaseModel):
    chat_id: uuid.UUID


class FolderResponse(BaseModel):
    id: uuid.UUID
    title: str
    icon: str | None = None
    items: list[FolderItemResponse]

    model_config = ConfigDict(from_attributes=True)
