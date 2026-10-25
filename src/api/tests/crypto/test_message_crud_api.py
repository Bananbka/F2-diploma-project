"""Message CRUD on plain (unencrypted) chats.

`test_message_envelope_api.py` covers the envelope path — epoch enforcement, signature
verification, the chain-index edit rule. This file covers what is left: a plain `POST`, a plain
`PUT`, `DELETE` and its orphaned-attachment cleanup, and the ownership/membership checks that gate
all three, none of which need an encrypted chat to exercise.
"""

from app.core.config import settings
from app.infrastructure.minio import minio_manager

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"


async def _send(client, chat_id, content="hello", attachments=None) -> dict:
    body = {"chat_id": str(chat_id), "encrypted_content": content}
    if attachments is not None:
        body["attachments"] = attachments
    r = await client.post("/messages/", json=body)
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


async def test_plain_message_round_trip():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "hello there")

        assert msg["content_format"] == "legacy_plaintext"
        assert msg["is_encrypted"] is False
        assert msg["encrypted_content"] == "hello there"
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


async def test_edit_updates_content_and_marks_edited():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        msg = await _send(alice, chat_id, "before")

        r = await alice.put(
            f"/messages/{msg['_id']}", json={"encrypted_content": "after"}
        )
        assert r.status_code == 200, r.text
        updated = r.json()["data"]
        assert updated["encrypted_content"] == "after"
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
            f"/messages/{msg['_id']}", json={"encrypted_content": "hijacked"}
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
        r = await alice.put(
            f"/messages/{msg['_id']}", json={"encrypted_content": "still with file"}
        )
        assert r.status_code == 200, r.text
        assert len(r.json()["data"]["attachments"]) == 1

        # Explicitly supplying an empty list clears them.
        r = await alice.put(
            f"/messages/{msg['_id']}",
            json={"encrypted_content": "no more file", "attachments": []},
        )
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


async def test_envelope_on_an_unencrypted_chat_is_rejected():
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
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "ENVELOPE_NOT_ALLOWED"
    finally:
        await alice.aclose()
        await bob.aclose()
