import uuid

from fastapi import APIRouter, UploadFile, File, Depends, Form, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.responses import SuccessResponse
from app.domains.files.schemas.file_schemas import FileCategory
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.minio import minio_manager
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/files", tags=["Files"])

MAX_FILE_SIZE = 1024 * 1024 * 50


@router.post("/upload", response_model=SuccessResponse[dict])
async def upload_file(file: UploadFile = File(...), category: FileCategory = Form(FileCategory.MESSAGE),
                      user: User = Depends(get_current_user)):
    target_bucket = (
        settings.MINIO_AVATAR_BUCKET
        if category == FileCategory.AVATAR
        else settings.MINIO_MESSAGE_BUCKET
    )

    file_bytes = await file.read()
    file_size = len(file_bytes)

    if file_size > MAX_FILE_SIZE:
        raise AppException(413, "FILE_SIZE_TOO_LARGE",
                           f"File size exceeds the maximum limit of {MAX_FILE_SIZE / (1024 * 1024)} MB.")

    filename = file.filename or "encrypted_file.enc"
    content_type = file.content_type or "application/octet-stream"

    file_url = await minio_manager.upload_file(
        file_bytes=file_bytes,
        original_filename=filename,
        content_type=content_type,
        bucket_name=target_bucket,
    )

    attachment_data = {
        "url": file_url,
        "name": filename,
        "size": file_size,
        "content_type": content_type,
    }

    return SuccessResponse(data=attachment_data)


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
