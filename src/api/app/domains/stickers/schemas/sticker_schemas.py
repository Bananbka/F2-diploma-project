import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.config import settings


class StickerCreateRequest(BaseModel):
    image_url: str
    emoji: str = Field(..., max_length=8)
    position: int | None = None

    @field_validator("image_url")
    @classmethod
    def validate_image_url(cls, v: str) -> str:
        """Anchor the url to the sticker bucket, same single-segment check as `Attachment.url`
        and `avatar_url` — without it the value is client-controlled and flows into MinIO
        deletion when the sticker or pack is removed."""
        # Stickers are a public-bucket image, so the stored url is built from MINIO_PUBLIC_URL
        # (see MinioClient.upload_file), not the internal MINIO_URL.
        prefix = f"{settings.MINIO_PUBLIC_URL}/{settings.MINIO_STICKER_BUCKET}/"
        if not v.startswith(prefix):
            raise ValueError("image_url must point at the sticker assets bucket.")

        object_key = v[len(prefix):]
        if not object_key or "/" in object_key:
            raise ValueError("image_url must reference a single object key.")

        return v


class StickerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    pack_id: uuid.UUID
    image_url: str
    emoji: str
    position: int


class StickerPackCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=100)


class StickerPackUpdateRequest(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=100)
    is_public: bool | None = None


class StickerPackResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_id: uuid.UUID
    title: str
    is_public: bool
    stickers: list[StickerResponse] = []


class StickerPackSummary(BaseModel):
    """Lighter shape for list/tray/discovery endpoints — avoids loading every sticker per pack."""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_id: uuid.UUID
    title: str
    is_public: bool
    sticker_count: int
    cover_image_url: str | None = None
