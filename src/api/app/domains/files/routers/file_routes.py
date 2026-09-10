import uuid

from fastapi import APIRouter, UploadFile, File, Depends, Form, Response
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.core.responses import SuccessResponse
from app.domains.files.schemas.file_schemas import FileCategory
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.minio import minio_manager
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis

router = APIRouter(prefix="/files", tags=["Files"])

MAX_FILE_SIZE = 1024 * 1024 * 50
MAX_AVATAR_SIZE = 1024 * 1024 * 5

# Read in chunks so the limit is enforced *while* reading rather than after. `await file.read()`
# pulled the entire body into memory first and only then compared it against the cap, so a single
# oversized upload could exhaust the process before the check ever ran.
UPLOAD_CHUNK_BYTES = 1024 * 1024

# Avatars are served from a public-read bucket with the Content-Type the client supplied. Anything
# outside this list turns that bucket into arbitrary hosting on the deployment's own domain —
# an HTML or SVG "avatar" is a script, not a picture.
ALLOWED_AVATAR_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

UPLOAD_WINDOW = 3600
UPLOAD_LIMIT = 100


async def _read_bounded(file: UploadFile, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0

    while chunk := await file.read(UPLOAD_CHUNK_BYTES):
        total += len(chunk)
        if total > limit:
            raise AppException(
                413, "FILE_SIZE_TOO_LARGE",
                f"File size exceeds the maximum limit of {limit // (1024 * 1024)} MB.",
            )
        chunks.append(chunk)

    return b"".join(chunks)


@router.post("/upload", response_model=SuccessResponse[dict])
async def upload_file(file: UploadFile = File(...), category: FileCategory = Form(FileCategory.MESSAGE),
                      user: User = Depends(get_current_user),
                      redis: Redis = Depends(get_redis)):
    await enforce_rate_limit(
        redis, scope="upload", identifier=str(user.id),
        limit=UPLOAD_LIMIT, window_seconds=UPLOAD_WINDOW,
        message="Too many uploads. Please wait before uploading more.",
    )

    is_avatar = category == FileCategory.AVATAR
    target_bucket = settings.MINIO_AVATAR_BUCKET if is_avatar else settings.MINIO_MESSAGE_BUCKET

    filename = file.filename or "encrypted_file.enc"
    content_type = file.content_type or "application/octet-stream"

    if is_avatar and content_type not in ALLOWED_AVATAR_TYPES:
        raise AppException(
            415, "UNSUPPORTED_MEDIA_TYPE",
            "Avatars must be a JPEG, PNG, WebP or GIF image.",
        )

    file_bytes = await _read_bounded(file, MAX_AVATAR_SIZE if is_avatar else MAX_FILE_SIZE)
    file_size = len(file_bytes)

    if file_size == 0:
        raise AppException(400, "EMPTY_FILE", "The uploaded file is empty.")

    if is_avatar and not _looks_like_image(file_bytes):
        # The declared Content-Type is client-supplied. Checking the leading bytes stops a file
        # that merely claims to be a PNG from being served as one from a public bucket.
        raise AppException(415, "UNSUPPORTED_MEDIA_TYPE", "That file is not a recognised image.")

    file_url = await minio_manager.upload_file(
        file_bytes=file_bytes,
        original_filename=filename,
        content_type=content_type,
        bucket_name=target_bucket,
        # Message attachments are ciphertext and are served through this API, never inline.
        force_octet_stream=not is_avatar,
        owner_id=str(user.id),
    )

    attachment_data = {
        "url": file_url,
        "name": filename,
        "size": file_size,
        "content_type": content_type,
    }

    return SuccessResponse(data=attachment_data)


def _looks_like_image(data: bytes) -> bool:
    """Magic-number check for the formats the avatar bucket accepts."""
    return (
        data.startswith(b"\xff\xd8\xff")                       # JPEG
        or data.startswith(b"\x89PNG\r\n\x1a\n")               # PNG
        or data.startswith(b"GIF87a") or data.startswith(b"GIF89a")
        or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")     # WebP
    )


@router.get("/attachments/{chat_id}/{object_key}")
async def download_attachment(
        chat_id: uuid.UUID,
        object_key: str,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
        mongo_db=Depends(get_mongo_db),
):
    """Serve an attachment, authorising against Postgres first.

    The message bucket has no public-read policy, so this is the only way to read one. Two checks,
    because either alone is insufficient: chat membership, and that the object is actually referenced
    by a message in *that* chat. Membership alone would let any member of any chat fetch any object
    key in the bucket, since keys are a flat UUID namespace shared across every conversation.

    The content is ciphertext — the server cannot read it and does not try. This endpoint decides who
    may fetch the bytes, not what they mean.
    """
    await messages_service.get_chat_or_403(db, chat_id, user.id)

    file_url = f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/{object_key}"

    referenced = await mongo_db["messages"].find_one(
        {"chat_id": chat_id, "attachments.url": file_url}, {"_id": 1}
    )
    if referenced is None:
        raise AppException(404, "ATTACHMENT_NOT_FOUND", "No attachment with that key in this chat.")

    try:
        body, content_type, length = await minio_manager.stream_object(
            object_key, settings.MINIO_MESSAGE_BUCKET
        )
    except Exception:
        # The row survives but the object does not — most often the 24h GC reaped a blob whose
        # message was never sent, or an earlier delete removed it.
        raise AppException(410, "ATTACHMENT_GONE", "This attachment is no longer stored.")

    return Response(
        content=body,
        media_type=content_type,
        headers={
            "Content-Length": str(length),
            # Never inline: the payload is attacker-supplied ciphertext, and rendering it in the
            # origin would hand any content-sniffing bug a same-origin foothold.
            "Content-Disposition": f'attachment; filename="{object_key}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=300",
        },
    )
