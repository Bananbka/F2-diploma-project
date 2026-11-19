"""Message CRUD, and the rule that the server never stores new plaintext.

`test_message_envelope_api.py` covers the envelope cryptography itself — epoch enforcement,
signature verification, the chain-index edit rule. This file covers `POST`, `PUT`, `DELETE` and its
orphaned-attachment cleanup, the ownership/membership checks that gate all three, and the B-M1
rule: a private or group message must be a sealed envelope in a chat whose encryption has been
enabled. `encrypted_content` without an envelope is refused (ENVELOPE_REQUIRED) whether or not the
chat has crypto settings yet, and nothing ever writes a LEGACY_* document. Legacy documents already
in Mongo stay readable.
"""

import datetime
import uuid

from app.core.config import settings
from app.infrastructure.minio import minio_manager
from app.infrastructure.mongo import connect_to_mongo, mongo_client

from tests.crypto.sealing import edit_sealed, enable, seal_for, send_sealed
from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"


async def _send(client, chat_id, content="hello", attachments=None) -> dict:
    extra = {}
    if attachments is not None:
        extra["attachments"] = attachments
    r = await send_sealed(client, chat_id, content, **extra)
    assert r.status_code == 201, r.text
    return r.json()["data"]


async def _upload(client, content=b"ciphertext-bytes", name="note.enc"):
    r = await client.post(
        "/files/upload",
        files={"file": (name, content, "application/octet-stream")},
        data={"category": "message"},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def _private_chat(alice, bob_id) -> uuid.UUID:
    r = await alice.post("/chats/private", json={"target_user_id": str(bob_id)})
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["id"])


async def _count_messages(chat_id) -> int:
    await connect_to_mongo()
    return await mongo_client.db["messages"].count_documents({"chat_id": uuid.UUID(str(chat_id))})


async def test_sealed_message_round_trip():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "hello there")

        assert msg["content_format"] == "sender_keys_v1"
        assert msg["is_encrypted"] is True
        assert msg["encrypted_content"] is None
        assert msg["envelope"] is not None
        assert msg["is_edited"] is False
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_sending_requires_chat_membership():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)

        r = await mallory.post(
            "/messages/", json={"chat_id": str(chat_id), "encrypted_content": "hi"}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_create_requires_exactly_one_content_form():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post("/messages/", json={"chat_id": str(chat_id)})
        assert r.status_code == 422, r.text

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "channel_post": {
                    "post_id": "00000000-0000-0000-0000-000000000000",
                    "content": "x",
                    "sig": "x",
                },
            },
        )
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


# --- B-M1: no new plaintext, ever ------------------------------------------------------------


async def test_plaintext_send_is_refused_in_a_chat_without_crypto_settings():
    """A fresh private chat and a fresh group have no ChatCryptoSettings row. That must not make
    them plaintext chats: a modified client posting `encrypted_content` before anyone enabled
    encryption is refused, and nothing is stored."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        private_id = await _private_chat(alice, bob_id)
        group_id = await _group_with(alice, bob_id)

        for chat_id in (private_id, group_id):
            r = await alice.post(
                "/messages/", json={"chat_id": str(chat_id), "encrypted_content": "in the clear"}
            )
            assert r.status_code == 400, r.text
            assert r.json()["error_code"] == "ENVELOPE_REQUIRED"
            assert await _count_messages(chat_id) == 0

            # The chat is still unencrypted: the refusal must not have enabled anything.
            r = await alice.get(f"/crypto/chats/{chat_id}/keys")
            assert r.json()["error_code"] == "CRYPTO_NOT_ENABLED"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_plaintext_send_is_refused_in_an_encrypted_chat():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _private_chat(alice, bob_id)
        await _send(alice, chat_id, "sealed")  # enables encryption, like the client's first open

        r = await alice.post(
            "/messages/", json={"chat_id": str(chat_id), "encrypted_content": "in the clear"}
        )
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "ENVELOPE_REQUIRED"
        assert await _count_messages(chat_id) == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_plaintext_is_refused_on_every_send_shape():
    """Reply, forward, attachment-carrying and channel-post-shaped sends all take the same gate."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        original = await _send(alice, chat_id, "original")
        attachment = await _upload(alice)

        shapes = [
            {"encrypted_content": "reply", "reply_to_message_id": original["_id"]},
            {
                "encrypted_content": "forward",
                "forwarded_from": {
                    "user_id": str(bob_id), "created_at": "2026-01-01T00:00:00+00:00",
                },
            },
            {"encrypted_content": "", "attachments": [attachment]},
            {
                "channel_post": {
                    "post_id": str(uuid.uuid4()), "content": "not a channel", "sig": "AAAA",
                },
            },
        ]
        for shape in shapes:
            r = await alice.post("/messages/", json={"chat_id": str(chat_id), **shape})
            assert r.status_code == 400, (shape, r.text)
            assert r.json()["error_code"] == "ENVELOPE_REQUIRED", shape

        assert await _count_messages(chat_id) == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_envelope_on_a_chat_without_crypto_settings_is_refused():
    """An envelope cannot be verified against an epoch that does not exist; enable first."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "envelope": {
                    "alg": "x",
                    "epoch": 1,
                    "skid": "00000000-0000-0000-0000-000000000000",
                    "idx": 0,
                    "n": "x",
                    "ct": "x",
                    "sig": "x",
                },
            },
        )
        assert r.status_code == 409, r.text
        assert r.json()["error_code"] == "CRYPTO_NOT_ENABLED"
        assert await _count_messages(chat_id) == 0
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_plaintext_edit_is_refused_in_an_encrypted_chat():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "before")

        r = await alice.put(f"/messages/{msg['_id']}", json={"encrypted_content": "after"})
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "ENVELOPE_REQUIRED"

        await connect_to_mongo()
        doc = await mongo_client.db["messages"].find_one({"chat_id": chat_id})
        assert doc["encrypted_content"] is None
        assert doc["is_edited"] is False
    finally:
        await alice.aclose()
        await bob.aclose()


async def _insert_legacy(chat_id, sender_id, content="old plaintext") -> str:
    """A pre-migration document, written straight to Mongo the way the old server wrote it."""
    await connect_to_mongo()
    res = await mongo_client.db["messages"].insert_one({
        "chat_id": uuid.UUID(str(chat_id)),
        "sender_id": uuid.UUID(str(sender_id)),
        "encrypted_content": content,
        "attachments": [],
        "is_edited": False,
        "created_at": datetime.datetime.now(datetime.timezone.utc),
    })
    return str(res.inserted_id)


async def test_legacy_history_stays_readable_but_cannot_be_rewritten_as_plaintext():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        private_id = await _private_chat(alice, bob_id)
        group_id = await _group_with(alice, bob_id)

        legacy_private = await _insert_legacy(private_id, alice_id)
        legacy_group = await _insert_legacy(group_id, alice_id)

        for chat_id, msg_id, fmt in (
            (private_id, legacy_private, "legacy_rsa"),
            (group_id, legacy_group, "legacy_plaintext"),
        ):
            r = await bob.get(f"/chats/{chat_id}/messages")
            assert r.status_code == 200, r.text
            [fetched] = r.json()["data"]
            assert fetched["_id"] == msg_id
            assert fetched["content_format"] == fmt
            assert fetched["is_encrypted"] is (fmt == "legacy_rsa")
            assert fetched["encrypted_content"] == "old plaintext"

            # Editing it with new plaintext is refused, in an unenabled chat as in any other.
            r = await alice.put(f"/messages/{msg_id}", json={"encrypted_content": "rewritten"})
            assert r.status_code == 400, r.text
            assert r.json()["error_code"] == "ENVELOPE_REQUIRED"

        # Once the chat is encrypted, a legacy message can only be replaced by an envelope.
        await enable(alice, group_id)
        r = await edit_sealed(alice, legacy_group, group_id, "now sealed")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["content_format"] == "sender_keys_v1"
        assert r.json()["data"]["encrypted_content"] is None

        r = await bob.get(f"/chats/{private_id}/messages")
        assert r.json()["data"][0]["encrypted_content"] == "old plaintext"
    finally:
        await alice.aclose()
        await bob.aclose()


# --- edit / delete ---------------------------------------------------------------------------


async def test_edit_updates_content_and_marks_edited():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "before")

        r = await edit_sealed(alice, msg["_id"], chat_id, "after")
        assert r.status_code == 200, r.text
        updated = r.json()["data"]
        assert updated["envelope"] != msg["envelope"]
        assert updated["encrypted_content"] is None
        assert updated["is_edited"] is True
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_only_the_sender_may_edit_or_delete():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "mine")

        r = await bob.put(
            f"/messages/{msg['_id']}", json={"envelope": await seal_for(bob, chat_id, "hijacked")}
        )
        assert r.status_code == 403, r.text

        r = await bob.delete(f"/messages/{msg['_id']}")
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_update_requires_exactly_one_content_form():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "before")

        r = await alice.put(f"/messages/{msg['_id']}", json={})
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_edit_can_replace_attachments_wholesale_or_clear_them():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        attachment = await _upload(alice)
        msg = await _send(alice, chat_id, "with file", attachments=[attachment])
        assert len(msg["attachments"]) == 1

        # Omitting the field entirely leaves the existing attachments untouched.
        r = await edit_sealed(alice, msg["_id"], chat_id, "still with file")
        assert r.status_code == 200, r.text
        assert len(r.json()["data"]["attachments"]) == 1

        # Explicitly supplying an empty list clears them.
        r = await edit_sealed(alice, msg["_id"], chat_id, "no more file", attachments=[])
        assert r.status_code == 200, r.text
        assert r.json()["data"]["attachments"] == []
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_delete_removes_the_message():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "ephemeral")

        r = await alice.delete(f"/messages/{msg['_id']}")
        assert r.status_code == 200, r.text

        # A second delete of the same (now-missing) message is a 404, not a crash.
        r = await alice.delete(f"/messages/{msg['_id']}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def _object_key(url: str) -> str:
    return url.rsplit("/", 1)[-1]


async def test_delete_reaps_an_attachment_no_longer_referenced_by_any_message():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        attachment = await _upload(alice)
        msg = await _send(alice, chat_id, "with file", attachments=[attachment])
        key = await _object_key(attachment["url"])

        exists, _ = await minio_manager.get_object_owner(
            key, settings.MINIO_MESSAGE_BUCKET
        )
        assert exists

        r = await alice.delete(f"/messages/{msg['_id']}")
        assert r.status_code == 200, r.text

        exists, _ = await minio_manager.get_object_owner(
            key, settings.MINIO_MESSAGE_BUCKET
        )
        assert not exists, "an attachment orphaned by the delete must be reaped"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_delete_does_not_reap_an_attachment_still_referenced_by_another_message():
    """A forwarded or duplicated attachment url can be named by more than one message — deleting
    one must not destroy the object the other still needs."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        attachment = await _upload(alice)

        first = await _send(alice, chat_id, "first copy", attachments=[attachment])
        await _send(alice, chat_id, "second copy", attachments=[attachment])
        key = await _object_key(attachment["url"])

        r = await alice.delete(f"/messages/{first['_id']}")
        assert r.status_code == 200, r.text

        exists, _ = await minio_manager.get_object_owner(
            key, settings.MINIO_MESSAGE_BUCKET
        )
        assert exists, "still referenced by the surviving message"
    finally:
        await alice.aclose()
        await bob.aclose()
