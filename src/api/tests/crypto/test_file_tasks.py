"""Celery task in `app/domains/files/tasks.py`: the MinIO/RustFS orphan sweep.

Extended this branch with the avatar sweep (`cleanup_minio_avatar_orphans`) and the sticker sweep
(`cleanup_minio_sticker_orphans`) alongside the pre-existing message-bucket sweep
(`cleanup_minio_orphans`), and none of them had a dedicated test. `ORPHAN_AGE` (24h) is monkeypatched down to zero for the duration of each test — there is no
way to backdate an object's real `LastModified` in S3/RustFS, and waiting 24 real hours is not a
reasonable test. With the age threshold at zero, "older than ORPHAN_AGE" is true for anything that
already exists, which is exactly what lets these tests observe the orphan/referenced distinction
the sweep is actually responsible for, without touching the age logic itself (that part is a
one-line comparison, not what's at risk here).
"""

import uuid
from datetime import timedelta

import app.domains.files.tasks as files_tasks
from app.core.config import settings
from app.infrastructure.minio import minio_manager

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user


class _zero_orphan_age:
    """Temporarily treats every existing object as old enough to be swept."""

    def __enter__(self):
        self._original = files_tasks.ORPHAN_AGE
        files_tasks.ORPHAN_AGE = timedelta(seconds=0)
        return self

    def __exit__(self, *exc):
        files_tasks.ORPHAN_AGE = self._original


async def _upload_message_object(content: bytes) -> str:
    return await minio_manager.upload_file(
        file_bytes=content,
        original_filename="note.enc",
        content_type="application/octet-stream",
        bucket_name=settings.MINIO_MESSAGE_BUCKET,
        force_octet_stream=True,
    )


async def _upload_avatar_object(content: bytes) -> str:
    return await minio_manager.upload_file(
        file_bytes=content,
        original_filename="avatar.png",
        content_type="image/png",
        bucket_name=settings.MINIO_AVATAR_BUCKET,
        public=True,
    )


async def _upload_sticker_object(content: bytes) -> str:
    return await minio_manager.upload_file(
        file_bytes=content,
        original_filename="sticker.png",
        content_type="image/png",
        bucket_name=settings.MINIO_STICKER_BUCKET,
        public=True,
    )


def _key_of(url: str) -> str:
    return url.rsplit("/", 1)[-1]


async def _exists(key: str, bucket: str) -> bool:
    exists, _ = await minio_manager.get_object_owner(key, bucket)
    return exists


async def test_cleanup_minio_orphans_deletes_an_unreferenced_object():
    orphan_url = await _upload_message_object(f"orphan-{uuid.uuid4()}".encode())
    orphan_key = _key_of(orphan_url)

    assert await _exists(orphan_key, settings.MINIO_MESSAGE_BUCKET)

    with _zero_orphan_age():
        await files_tasks.cleanup_minio_orphans()

    assert not await _exists(orphan_key, settings.MINIO_MESSAGE_BUCKET)


async def test_cleanup_minio_orphans_keeps_an_object_referenced_by_a_message():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(
            "/files/upload",
            files={"file": ("note.enc", b"referenced-bytes", "application/octet-stream")},
            data={"category": "message"},
        )
        assert r.status_code == 200, r.text
        attachment = r.json()["data"]
        key = _key_of(attachment["url"])

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 201, r.text

        with _zero_orphan_age():
            await files_tasks.cleanup_minio_orphans()

        assert await _exists(key, settings.MINIO_MESSAGE_BUCKET), (
            "an attachment a live message still points at must survive the sweep"
        )
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_cleanup_minio_avatar_orphans_deletes_an_unreferenced_object():
    orphan_url = await _upload_avatar_object(f"orphan-{uuid.uuid4()}".encode())
    orphan_key = _key_of(orphan_url)

    assert await _exists(orphan_key, settings.MINIO_AVATAR_BUCKET)

    with _zero_orphan_age():
        await files_tasks.cleanup_minio_avatar_orphans()

    assert not await _exists(orphan_key, settings.MINIO_AVATAR_BUCKET)


async def test_cleanup_minio_avatar_orphans_keeps_a_users_current_avatar():
    alice, alice_id = await _register_user()
    try:
        # public=True, matching how the real upload endpoint stores avatars: the browser-reachable
        # MINIO_PUBLIC_URL form, which is what `_validate_avatar_url` requires and what
        # `cleanup_minio_avatar_orphans` reads back out of the `avatar_url` column.
        avatar_url = await _upload_avatar_object(f"avatar-{uuid.uuid4()}".encode())
        r = await alice.patch("/profile/me", json={"avatar_url": avatar_url})
        assert r.status_code == 200, r.text

        key = _key_of(avatar_url)

        with _zero_orphan_age():
            await files_tasks.cleanup_minio_avatar_orphans()

        assert await _exists(key, settings.MINIO_AVATAR_BUCKET), (
            "a user's current avatar must survive the sweep"
        )
    finally:
        await alice.aclose()


async def test_cleanup_minio_sticker_orphans_deletes_an_unreferenced_object():
    orphan_url = await _upload_sticker_object(f"orphan-{uuid.uuid4()}".encode())
    orphan_key = _key_of(orphan_url)

    assert await _exists(orphan_key, settings.MINIO_STICKER_BUCKET)

    with _zero_orphan_age():
        await files_tasks.cleanup_minio_sticker_orphans()

    assert not await _exists(orphan_key, settings.MINIO_STICKER_BUCKET)


async def test_cleanup_minio_sticker_orphans_keeps_a_sticker_attached_to_a_pack():
    alice, alice_id = await _register_user()
    try:
        r = await alice.post("/stickers/packs", json={"title": "Test Pack"})
        assert r.status_code == 200, r.text
        pack_id = r.json()["data"]["id"]

        image_url = await _upload_sticker_object(f"sticker-{uuid.uuid4()}".encode())
        key = _key_of(image_url)

        r = await alice.post(
            f"/stickers/packs/{pack_id}/stickers",
            json={"image_url": image_url, "emoji": "😀"},
        )
        assert r.status_code == 200, r.text

        with _zero_orphan_age():
            await files_tasks.cleanup_minio_sticker_orphans()

        assert await _exists(key, settings.MINIO_STICKER_BUCKET), (
            "a sticker still attached to a pack must survive the sweep"
        )
    finally:
        await alice.aclose()
