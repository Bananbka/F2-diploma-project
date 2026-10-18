"""`PATCH /profile/me`.

Every field is genuinely optional: an explicit `null` on `username` or `full_name` is a 400
(clearing either would violate a NOT NULL column or blank the sender's own display name), while
omitting the key entirely is how you leave it alone. On avatar replace, the old object is deleted
from the bucket — but only once the replacement has actually committed, and only when the avatar
actually changed.
"""

import uuid

from app.core.config import settings
from app.infrastructure.minio import minio_manager

from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"


async def _upload_avatar(client, content: bytes = None) -> dict:
    # A one-pixel PNG, magic-number checked by the upload endpoint.
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080600000"
        "01f15c4890000000a49444154789c6300010000050001"
        "0d0a2db40000000049454e44ae426082"
    )
    r = await client.post(
        "/files/upload",
        files={"file": ("avatar.png", content or png, "image/png")},
        data={"category": "avatar"},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _key_of(url: str) -> str:
    return url.rsplit("/", 1)[-1]


async def test_patch_me_updates_only_the_supplied_field():
    alice, alice_id = await _register_user()
    try:
        before = (await alice.get("/profile/me")).json()["data"]

        r = await alice.patch("/profile/me", json={"bio": "hello there"})
        assert r.status_code == 200, r.text
        data = r.json()["data"]

        assert data["bio"] == "hello there"
        assert data["full_name"] == before["full_name"]
        assert data["username"] == before["username"]
    finally:
        await alice.aclose()


async def test_patch_me_empty_body_is_a_noop():
    alice, alice_id = await _register_user()
    try:
        before = (await alice.get("/profile/me")).json()["data"]

        r = await alice.patch("/profile/me", json={})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["username"] == before["username"]
    finally:
        await alice.aclose()


async def test_explicit_null_username_is_a_400_not_a_500():
    alice, alice_id = await _register_user()
    try:
        r = await alice.patch("/profile/me", json={"username": None})
        assert r.status_code == 400, r.text
    finally:
        await alice.aclose()


async def test_explicit_null_full_name_is_a_400():
    alice, alice_id = await _register_user()
    try:
        r = await alice.patch("/profile/me", json={"full_name": None})
        assert r.status_code == 400, r.text
    finally:
        await alice.aclose()


async def test_omitting_username_leaves_it_unchanged():
    alice, alice_id = await _register_user()
    try:
        before = (await alice.get("/profile/me")).json()["data"]["username"]

        r = await alice.patch("/profile/me", json={"bio": "just a bio update"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["username"] == before
    finally:
        await alice.aclose()


async def test_patch_me_rejects_a_taken_username():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        bob_username = (await bob.get("/profile/me")).json()["data"]["username"]

        r = await alice.patch("/profile/me", json={"username": bob_username})
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "USERNAME_TAKEN"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_patch_me_accepts_its_own_unchanged_username():
    """Renaming to the name you already hold must not trip the collision check."""
    alice, alice_id = await _register_user()
    try:
        own_username = (await alice.get("/profile/me")).json()["data"]["username"]

        r = await alice.patch("/profile/me", json={"username": own_username})
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()


async def test_replacing_the_avatar_deletes_the_old_object():
    alice, alice_id = await _register_user()
    try:
        first = await _upload_avatar(alice)
        r = await alice.patch("/profile/me", json={"avatar_url": first["url"]})
        assert r.status_code == 200, r.text

        old_key = _key_of(first["url"])
        exists, _ = await minio_manager.get_object_owner(
            old_key, settings.MINIO_AVATAR_BUCKET
        )
        assert exists, "the avatar we just set must exist"

        second = await _upload_avatar(alice)
        r = await alice.patch("/profile/me", json={"avatar_url": second["url"]})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["avatar_url"] == second["url"]

        exists, _ = await minio_manager.get_object_owner(
            old_key, settings.MINIO_AVATAR_BUCKET
        )
        assert not exists, "the orphaned old avatar must have been reaped"

        new_key = _key_of(second["url"])
        exists, _ = await minio_manager.get_object_owner(
            new_key, settings.MINIO_AVATAR_BUCKET
        )
        assert exists, "the new avatar must survive its own PATCH"
    finally:
        await alice.aclose()


async def test_a_patch_that_does_not_touch_the_avatar_leaves_it_alone():
    alice, alice_id = await _register_user()
    try:
        avatar = await _upload_avatar(alice)
        r = await alice.patch("/profile/me", json={"avatar_url": avatar["url"]})
        assert r.status_code == 200, r.text

        r = await alice.patch("/profile/me", json={"bio": "unrelated update"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["avatar_url"] == avatar["url"]

        key = _key_of(avatar["url"])
        exists, _ = await minio_manager.get_object_owner(
            key, settings.MINIO_AVATAR_BUCKET
        )
        assert exists, "an unrelated PATCH must not touch the current avatar"
    finally:
        await alice.aclose()


async def test_is_username_available():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        bob_username = (await bob.get("/profile/me")).json()["data"]["username"]

        r = await alice.get(f"/profile/is-username-available/{bob_username}")
        assert r.status_code == 200, r.text
        assert r.json()["data"] is False

        r = await alice.get(f"/profile/is-username-available/nobody{uuid.uuid4().hex[:8]}")
        assert r.status_code == 200, r.text
        assert r.json()["data"] is True
    finally:
        await alice.aclose()
        await bob.aclose()
