"""End-to-end tests for the sticker pack domain against the running app.

Covers ownership enforcement on packs and stickers, the per-user/per-pack caps, subscribe/
unsubscribe idempotency, and the two compatibility fixes this domain required on the messages
side: `Attachment.validate_url` accepting the sticker bucket, and `_authorize_attachments`
skipping the ownership/visibility check for `kind == 'sticker'` attachments — which is the
intended behaviour (stickers have no secrecy requirement), not a hole.
"""

import contextlib
import uuid

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.config import settings as app_settings
from app.core.exceptions import AppException

# Registers the `users` table in the shared metadata before any sticker-pack FK to it is
# resolved — mirrors the celery-worker gotcha in CLAUDE.md: a module that never goes through
# `app.main` must explicitly import any model its relationships/FKs reference by table name, or
# SQLAlchemy cannot resolve them.
from app.domains.users.models import User  # noqa: F401
from app.domains.chats.models import ChatParticipant  # noqa: F401
from app.domains.stickers.services import sticker_pack_service, sticker_service
from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user


@contextlib.asynccontextmanager
async def _session():
    """A session on its own engine, disposed afterwards — same reasoning as `test_group_cap.py`:
    pytest-asyncio gives each test a fresh event loop, so the app's module-level engine would hand
    back pooled connections bound to a previous loop. Calling the service in-process (rather than
    over HTTP) is also what lets the cap be monkeypatched here, since the running API is a
    separate process that would never see a module attribute mutated from the test process."""
    engine = create_async_engine(app_settings.DATABASE_URL)
    try:
        async with async_sessionmaker(bind=engine, expire_on_commit=False)() as db:
            yield db
    finally:
        await engine.dispose()

# A one-pixel PNG, same fixture used by the files tests — sticker uploads are validated the same
# way avatar uploads are.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000a49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)


async def _upload_sticker_image(client) -> str:
    r = await client.post(
        "/files/upload",
        files={"file": ("sticker.png", PNG, "image/png")},
        data={"category": "sticker"},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["url"]


async def _create_pack(client, title="My Pack", is_public=False) -> str:
    r = await client.post("/stickers/packs", json={"title": title})
    assert r.status_code == 200, r.text
    pack_id = r.json()["data"]["id"]

    if is_public:
        r = await client.patch(f"/stickers/packs/{pack_id}", json={"is_public": True})
        assert r.status_code == 200, r.text

    return pack_id


async def _add_sticker(client, pack_id, emoji="\U0001F600") -> dict:
    image_url = await _upload_sticker_image(client)
    r = await client.post(
        f"/stickers/packs/{pack_id}/stickers",
        json={"image_url": image_url, "emoji": emoji},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def test_create_and_fetch_own_private_pack():
    alice, _ = await _register_user()
    try:
        pack_id = await _create_pack(alice)

        r = await alice.get(f"/stickers/packs/{pack_id}")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["title"] == "My Pack"
        assert r.json()["data"]["is_public"] is False
    finally:
        await alice.aclose()


async def test_non_owner_cannot_see_a_private_pack():
    alice, _ = await _register_user()
    bob, _ = await _register_user()

    try:
        pack_id = await _create_pack(alice)

        r = await bob.get(f"/stickers/packs/{pack_id}")
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_any_user_can_see_a_public_pack():
    alice, _ = await _register_user()
    bob, _ = await _register_user()

    try:
        pack_id = await _create_pack(alice, is_public=True)

        r = await bob.get(f"/stickers/packs/{pack_id}")
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_nonexistent_pack_is_404_not_403():
    alice, _ = await _register_user()
    try:
        r = await alice.get(f"/stickers/packs/{uuid.uuid4()}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()


async def test_only_owner_can_update_or_delete_even_a_public_pack():
    alice, _ = await _register_user()
    bob, _ = await _register_user()

    try:
        pack_id = await _create_pack(alice, is_public=True)

        r = await bob.patch(f"/stickers/packs/{pack_id}", json={"title": "Hijacked"})
        assert r.status_code == 403, r.text

        r = await bob.delete(f"/stickers/packs/{pack_id}")
        assert r.status_code == 403, r.text

        r = await alice.patch(f"/stickers/packs/{pack_id}", json={"title": "Renamed"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["title"] == "Renamed"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_only_owner_can_add_or_delete_stickers():
    alice, _ = await _register_user()
    bob, _ = await _register_user()

    try:
        pack_id = await _create_pack(alice, is_public=True)
        image_url = await _upload_sticker_image(bob)

        r = await bob.post(
            f"/stickers/packs/{pack_id}/stickers",
            json={"image_url": image_url, "emoji": "\U0001F600"},
        )
        assert r.status_code == 403, r.text

        sticker = await _add_sticker(alice, pack_id)

        r = await bob.delete(f"/stickers/packs/{pack_id}/stickers/{sticker['id']}")
        assert r.status_code == 403, r.text

        r = await alice.delete(f"/stickers/packs/{pack_id}/stickers/{sticker['id']}")
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_sticker_pack_cap_returns_400(monkeypatch):
    """Called in-process against the real DB, monkeypatching the cap, rather than through HTTP:
    the running API is a separate process, so a module attribute mutated from the test process
    would never be seen by it (and the production cap of 50 would otherwise have to be hit for
    real)."""
    monkeypatch.setattr(sticker_pack_service, "MAX_PACKS_PER_USER", 1)

    alice, alice_id = await _register_user()
    try:
        async with _session() as db:
            await sticker_pack_service.create_pack(db, alice_id, "First")

        async with _session() as db:
            with pytest.raises(AppException) as excinfo:
                await sticker_pack_service.create_pack(db, alice_id, "Second")
        assert excinfo.value.status_code == 400
        assert excinfo.value.error_code == "PACK_LIMIT_REACHED"
    finally:
        await alice.aclose()


async def test_sticker_per_pack_cap_returns_400(monkeypatch):
    monkeypatch.setattr(sticker_service, "MAX_STICKERS_PER_PACK", 1)

    alice, alice_id = await _register_user()
    try:
        pack_id = uuid.UUID(await _create_pack(alice))
        image_url_1 = await _upload_sticker_image(alice)
        image_url_2 = await _upload_sticker_image(alice)

        from app.domains.stickers.schemas.sticker_schemas import StickerCreateRequest

        async with _session() as db:
            await sticker_service.add_sticker(
                db,
                pack_id,
                alice_id,
                StickerCreateRequest(image_url=image_url_1, emoji="\U0001F600"),
            )

        async with _session() as db:
            with pytest.raises(AppException) as excinfo:
                await sticker_service.add_sticker(
                    db,
                    pack_id,
                    alice_id,
                    StickerCreateRequest(image_url=image_url_2, emoji="\U0001F601"),
                )
        assert excinfo.value.status_code == 400
        assert excinfo.value.error_code == "STICKER_LIMIT_REACHED"
    finally:
        await alice.aclose()


async def test_subscribe_is_idempotent_and_appears_in_tray():
    alice, _ = await _register_user()
    bob, _ = await _register_user()

    try:
        pack_id = await _create_pack(alice, is_public=True)
        await _add_sticker(alice, pack_id)

        r = await bob.post(f"/stickers/packs/{pack_id}/subscribe")
        assert r.status_code == 200, r.text

        # Subscribing twice must not error or duplicate.
        r = await bob.post(f"/stickers/packs/{pack_id}/subscribe")
        assert r.status_code == 200, r.text

        r = await bob.get("/stickers/packs/mine")
        assert r.status_code == 200, r.text
        tray = r.json()["data"]
        matching = [p for p in tray if p["id"] == pack_id]
        assert len(matching) == 1, tray
        assert matching[0]["sticker_count"] == 1

        r = await bob.delete(f"/stickers/packs/{pack_id}/subscribe")
        assert r.status_code == 200, r.text

        # Unsubscribing twice (second time a no-op) must not error either.
        r = await bob.delete(f"/stickers/packs/{pack_id}/subscribe")
        assert r.status_code == 200, r.text

        r = await bob.get("/stickers/packs/mine")
        tray = r.json()["data"]
        assert all(p["id"] != pack_id for p in tray)
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_cannot_subscribe_to_a_private_pack():
    alice, _ = await _register_user()
    bob, _ = await _register_user()

    try:
        pack_id = await _create_pack(alice, is_public=False)

        r = await bob.post(f"/stickers/packs/{pack_id}/subscribe")
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "PACK_NOT_PUBLIC"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_owner_pack_appears_in_own_tray_without_subscribing():
    alice, _ = await _register_user()
    try:
        pack_id = await _create_pack(alice)

        r = await alice.get("/stickers/packs/mine")
        assert r.status_code == 200, r.text
        assert any(p["id"] == pack_id for p in r.json()["data"])
    finally:
        await alice.aclose()


async def test_public_pack_listing_and_search():
    alice, _ = await _register_user()
    try:
        pack_id = await _create_pack(alice, title="Searchable Unique Title", is_public=True)

        r = await alice.get("/stickers/packs/public", params={"search": "Unique"})
        assert r.status_code == 200, r.text
        assert any(p["id"] == pack_id for p in r.json()["data"])

        r = await alice.get("/stickers/packs/public", params={"search": "NoSuchTitleAtAll"})
        assert r.status_code == 200, r.text
        assert all(p["id"] != pack_id for p in r.json()["data"])
    finally:
        await alice.aclose()


async def test_reorder_stickers_requires_the_exact_same_set():
    alice, _ = await _register_user()
    try:
        pack_id = await _create_pack(alice)
        s1 = await _add_sticker(alice, pack_id, emoji="\U0001F600")
        s2 = await _add_sticker(alice, pack_id, emoji="\U0001F601")

        # Wrong set: missing one id.
        r = await alice.put(
            f"/stickers/packs/{pack_id}/stickers/order", json=[s1["id"]]
        )
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "STICKER_SET_MISMATCH"

        # Correct set, reversed order.
        r = await alice.put(
            f"/stickers/packs/{pack_id}/stickers/order",
            json=[s2["id"], s1["id"]],
        )
        assert r.status_code == 200, r.text

        r = await alice.get(f"/stickers/packs/{pack_id}")
        stickers = r.json()["data"]["stickers"]
        assert [s["id"] for s in stickers] == [s2["id"], s1["id"]]
    finally:
        await alice.aclose()


async def test_sending_a_sticker_attachment_from_another_users_pack_succeeds():
    """The intended behaviour of the `_authorize_attachments`/`validate_url` fix: a sticker has
    no secrecy requirement, so a sender may attach one from a pack they merely subscribed to (or
    even one they never explicitly added), as long as it is a real sticker from some pack."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        pack_id = await _create_pack(alice, is_public=True)
        sticker = await _add_sticker(alice, pack_id)

        chat_id = await _group_with(bob, alice_id)

        # Bob never uploaded this image and is not the pack owner.
        r = await bob.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [
                    {
                        "url": sticker["image_url"],
                        "name": "sticker.png",
                        "size": len(PNG),
                        "content_type": "image/png",
                        "kind": "sticker",
                    }
                ],
            },
        )
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_sticker_attachment_url_must_point_at_the_sticker_bucket():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [
                    {
                        "url": "https://evil.example/fake-sticker.png",
                        "name": "n",
                        "size": 1,
                        "content_type": "image/png",
                        "kind": "sticker",
                    }
                ],
            },
        )
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_sticker_kind_cannot_be_used_to_claim_a_message_bucket_url():
    """Regression for the critical bug: `kind == 'sticker'` used to be the only gate in
    `_authorize_attachments`, so claiming that kind on a genuine MESSAGE-bucket url — one naming
    an object from a chat the sender was removed from — bypassed the ownership/visibility check
    entirely. `Attachment`'s own model validator now rejects the kind/bucket mismatch outright,
    before the attachment ever reaches the service-layer check; mirrors
    `test_cannot_attach_a_file_you_neither_uploaded_nor_can_see` in test_files_api.py."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        private_chat = await _group_with(alice, bob_id)
        mallory_chat = await _group_with(mallory, alice_id, title="Mallory's")

        r = await alice.post(
            "/files/upload",
            files={"file": ("note.enc", b"ciphertext-bytes", "application/octet-stream")},
            data={"category": "message"},
        )
        assert r.status_code == 200, r.text
        attachment = r.json()["data"]

        await alice.post(
            "/messages/",
            json={
                "chat_id": str(private_chat),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )

        # Mallory knows the key (from the message above) but neither uploaded it nor is in a
        # chat that references it. Claiming kind='sticker' on it must not bypass that check.
        sticker_shaped = dict(attachment, kind="sticker")
        r = await mallory.post(
            "/messages/",
            json={
                "chat_id": str(mallory_chat),
                "encrypted_content": "x",
                "attachments": [sticker_shaped],
            },
        )
        assert r.status_code in (400, 403, 422), r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_real_sticker_in_a_visible_pack_still_sends_successfully():
    """Positive-path guard alongside the regression test above: a genuine sticker — a real row
    in the `stickers` table, in a pack the sender can see — must still be attachable without
    requiring the sender to have uploaded it themselves."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        pack_id = await _create_pack(alice, is_public=True)
        sticker = await _add_sticker(alice, pack_id)

        chat_id = await _group_with(bob, alice_id)

        r = await bob.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [
                    {
                        "url": sticker["image_url"],
                        "name": "sticker.png",
                        "size": len(PNG),
                        "content_type": "image/png",
                        "kind": "sticker",
                    }
                ],
            },
        )
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_sticker_shaped_url_with_no_backing_row_is_rejected():
    """A URL merely anchored to the sticker bucket is not enough; it must name a real sticker."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        fake_url = f"{settings.MINIO_URL}/{settings.MINIO_STICKER_BUCKET}/{uuid.uuid4()}.png"
        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [
                    {
                        "url": fake_url,
                        "name": "n",
                        "size": 1,
                        "content_type": "image/png",
                        "kind": "sticker",
                    }
                ],
            },
        )
        assert r.status_code == 400, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_update_pack_rejects_explicit_null_title():
    alice, _ = await _register_user()
    try:
        pack_id = await _create_pack(alice)

        r = await alice.patch(f"/stickers/packs/{pack_id}", json={"title": None})
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "INVALID_TITLE"

        r = await alice.patch(f"/stickers/packs/{pack_id}", json={"is_public": None})
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "INVALID_IS_PUBLIC"
    finally:
        await alice.aclose()


async def test_delete_sticker_via_url_naming_a_different_owned_pack_is_404():
    alice, _ = await _register_user()
    try:
        pack_a = await _create_pack(alice, title="Pack A")
        pack_b = await _create_pack(alice, title="Pack B")
        sticker = await _add_sticker(alice, pack_a)

        # The sticker really belongs to pack_a; naming pack_b (also alice's own) must 404 rather
        # than silently deleting from pack_a.
        r = await alice.delete(f"/stickers/packs/{pack_b}/stickers/{sticker['id']}")
        assert r.status_code == 404, r.text

        r = await alice.delete(f"/stickers/packs/{pack_a}/stickers/{sticker['id']}")
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()


async def test_sticker_upload_rejects_non_image_payload():
    alice, _ = await _register_user()
    try:
        r = await alice.post(
            "/files/upload",
            files={"file": ("x.html", b"<script>alert(1)</script>", "text/html")},
            data={"category": "sticker"},
        )
        assert r.status_code == 415, r.text

        r = await alice.post(
            "/files/upload",
            files={"file": ("x.png", b"<script>alert(1)</script>", "image/png")},
            data={"category": "sticker"},
        )
        assert r.status_code == 415, r.text

        r = await alice.post(
            "/files/upload",
            files={"file": ("ok.png", PNG, "image/png")},
            data={"category": "sticker"},
        )
        assert r.status_code == 200, r.text
        assert settings.MINIO_STICKER_BUCKET in r.json()["data"]["url"]
    finally:
        await alice.aclose()


async def test_delete_pack_removes_its_stickers_from_minio_and_db():
    alice, _ = await _register_user()
    try:
        pack_id = await _create_pack(alice)
        sticker = await _add_sticker(alice, pack_id)

        r = await alice.delete(f"/stickers/packs/{pack_id}")
        assert r.status_code == 200, r.text

        r = await alice.get(f"/stickers/packs/{pack_id}")
        assert r.status_code == 404, r.text

        # The sticker row is gone too (cascade), not just the pack.
        r = await alice.delete(f"/stickers/packs/{pack_id}/stickers/{sticker['id']}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()
