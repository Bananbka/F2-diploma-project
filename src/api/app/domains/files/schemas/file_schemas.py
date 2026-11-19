import uuid
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

# Mirrors UPLOAD_LIMIT/UPLOAD_WINDOW's style in file_routes.py: a round number picked to comfortably
# cover one chat's worth of visible media (a busy chat screen full of images/voice notes) without
# letting a single request fan out into an unbounded number of object-store reads.
MAX_BATCH_ATTACHMENT_KEYS = 50


# Total raw (pre-base64) bytes one batch call will read from the object store. The key cap alone
# bounded nothing that mattered: 50 keys x 50 MB is 2.5 GB of ciphertext plus ~3.3 GB of base64,
# all held in memory at once to build one JSON body. The batch exists to coalesce a screenful of
# thumbnails and voice notes, which fits here many times over; large files are what the streaming
# single-object endpoint is for.
MAX_BATCH_ATTACHMENT_BYTES = 30 * 1024 * 1024


class FileCategory(str, Enum):
    MESSAGE = "message"
    AVATAR = "avatar"
    STICKER = "sticker"


class BatchAttachmentRequest(BaseModel):
    """Fetch several message-bucket attachments from one chat in a single round trip.

    Opening a chat with N visible attachments otherwise fires N separate
    `GET /files/attachments/{chat_id}/{object_key}` calls, each paying its own `get_chat_or_403`
    plus a Mongo `find_one`. This batches the authorization and the Mongo lookup into one call
    each; the object-store reads are still one per key, since RustFS/S3 has no batched GET.
    """
    model_config = ConfigDict(extra="forbid")

    chat_id: uuid.UUID
    object_keys: list[str] = Field(..., min_length=1, max_length=MAX_BATCH_ATTACHMENT_KEYS)


class AttachmentFetchStatus(str, Enum):
    OK = "ok"
    NOT_FOUND = "not_found"  # not referenced by any message in this chat
    GONE = "gone"            # referenced, but the object-store read failed (e.g. GC reaped it)
    # Authorised and present, but not included because it would take this call past
    # MAX_BATCH_ATTACHMENT_BYTES. Not an error about the object: fetch it on its own through
    # `GET /files/attachments/{chat_id}/{object_key}`, which streams. `content_length` is set.
    TOO_LARGE = "too_large"


class BatchAttachmentResult(BaseModel):
    """One key's outcome. `content_base64` is only set when `status == 'ok'`.

    `content_length` is the object's raw size and is set for `ok` and `too_large` alike, so a
    client told `too_large` knows what it is about to fetch individually.

    Base64 rather than a multipart response: the payload is already-opaque client-encrypted
    ciphertext, so base64's ~33% size overhead buys a plain JSON response (one schema, one
    content-type, trivial to consume from the Angular client) rather than a measurable loss —
    multipart would be the more bandwidth-correct choice, but not enough to justify the extra
    client-side parsing for bytes neither side can read anyway.
    """

    object_key: str
    status: AttachmentFetchStatus
    content_type: str | None = None
    content_base64: str | None = None
    content_length: int | None = None
