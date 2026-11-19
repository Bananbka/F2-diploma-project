"""Ownership checks for avatar-bucket objects.

The schema validators on `avatar_url` only anchor the value to the avatar bucket. That says where
the object lives, not whose it is — and the bucket is public-read, so every avatar url is known to
everyone who has ever seen it rendered. Without an ownership check, anyone could point their own
profile (or a group they create) at somebody else's avatar, and `PATCH /profile/me` would then
delete that object from the bucket the moment they switched away from it.

`POST /files/upload` records the uploader as `owner-id` object metadata, so ownership is answered
from the object itself rather than from anything the client says.
"""

import uuid

from app.core.config import settings
from app.core.exceptions import AppException
from app.infrastructure.minio import minio_manager


def avatar_object_key(url: str) -> str:
    """The object key of an avatar url. The schema validators already guarantee a single key."""
    return url.rsplit("/", 1)[-1]


async def is_owned_avatar(url: str, user_id: uuid.UUID) -> bool:
    """True only if the object exists and was uploaded by `user_id`.

    An object with no recorded owner (uploaded before ownership was recorded) is *not* owned by
    anyone for this purpose: claiming it is exactly the impersonation this closes, and refusing to
    delete it is safe, because the avatar garbage collector reaps it once nothing references it.
    """
    exists, owner = await minio_manager.get_object_owner(
        avatar_object_key(url), settings.MINIO_AVATAR_BUCKET
    )
    return exists and owner == str(user_id)


async def require_owned_avatar(url: str, user_id: uuid.UUID) -> None:
    """Raise unless `url` names an avatar object that `user_id` uploaded."""
    exists, owner = await minio_manager.get_object_owner(
        avatar_object_key(url), settings.MINIO_AVATAR_BUCKET
    )
    if not exists:
        raise AppException(400, "AVATAR_UNKNOWN", "That avatar does not exist. Upload it first.")
    if owner != str(user_id):
        raise AppException(403, "AVATAR_NOT_OWNED", "You can only use an avatar you uploaded.")
