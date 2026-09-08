"""Channels: signed broadcast, deliberately not encrypted."""
import uuid

import pytest

from app.domains.crypto.reference.channel import sign_channel_post, verify_channel_post
from app.domains.crypto.reference.identity import generate_identity
from app.domains.crypto.reference.primitives import b64u_encode

from tests.crypto.test_epoch_api import _publish_identity
from tests.crypto.test_identity_api import _register_user

ANNOUNCEMENT = "Release 2.0 ships on Friday."


def _post(keys, chat_id, sender_id, content=ANNOUNCEMENT):
    post_id = uuid.uuid4()
    return {
        "v": 1,
        "alg": "ed25519-post-v1",
        "post_id": str(post_id),
        "content": content,
        "sig": sign_channel_post(
            signing_private=keys.signing_private,
            chat_id=chat_id, sender_id=sender_id, post_id=post_id, content=content,
        ),
    }


async def _channel_with(owner, subscriber_ids, title="News"):
    r = await owner.post("/chats/channel", json={
        "title": title, "description": "d",
        "subscriber_ids": [str(s) for s in subscriber_ids],
    })
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["id"])


# --- reference crypto ---

def test_post_signature_round_trip():
    keys = generate_identity(uuid.uuid4(), uuid.uuid4())
    chat_id, sender_id, post_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    sig = sign_channel_post(
        signing_private=keys.signing_private,
        chat_id=chat_id, sender_id=sender_id, post_id=post_id, content=ANNOUNCEMENT,
    )

    assert verify_channel_post(
        signing_public=keys.signing_public, signature=sig,
        chat_id=chat_id, sender_id=sender_id, post_id=post_id, content=ANNOUNCEMENT,
    )


@pytest.mark.parametrize("field", ["chat_id", "sender_id", "post_id", "content"])
def test_post_signature_is_bound_to_every_field(field):
    """A signed post must not be relocatable, reattributable, duplicable or editable."""
    keys = generate_identity(uuid.uuid4(), uuid.uuid4())
    base = {
        "chat_id": uuid.uuid4(), "sender_id": uuid.uuid4(),
        "post_id": uuid.uuid4(), "content": ANNOUNCEMENT,
    }
    sig = sign_channel_post(signing_private=keys.signing_private, **base)

    tampered = dict(base)
    tampered[field] = "Release 2.0 is cancelled." if field == "content" else uuid.uuid4()

    assert not verify_channel_post(
        signing_public=keys.signing_public, signature=sig, **tampered
    )


def test_post_signature_detects_a_different_author():
    keys = generate_identity(uuid.uuid4(), uuid.uuid4())
    impostor = generate_identity(uuid.uuid4(), uuid.uuid4())
    base = {
        "chat_id": uuid.uuid4(), "sender_id": uuid.uuid4(),
        "post_id": uuid.uuid4(), "content": ANNOUNCEMENT,
    }
    sig = sign_channel_post(signing_private=keys.signing_private, **base)

    assert not verify_channel_post(
        signing_public=impostor.signing_public, signature=sig, **base
    )


# --- API ---

async def test_owner_can_post_and_subscribers_can_verify():
    owner, owner_id = await _register_user()
    subscriber, subscriber_id = await _register_user()
    try:
        _, owner_keys = await _publish_identity(owner, owner_id)

        chat_id = await _channel_with(owner, [subscriber_id])

        r = await owner.post("/messages/", json={
            "chat_id": str(chat_id), "channel_post": _post(owner_keys, chat_id, owner_id),
        })
        assert r.status_code == 200, r.text

        data = r.json()["data"]
        assert data["content_format"] == "channel_signed_v1"
        # Deliberately readable: channels trade confidentiality for scale.
        assert data["is_encrypted"] is False

        r = await subscriber.get(f"/chats/{chat_id}/messages")
        assert r.status_code == 200, r.text
        fetched = r.json()["data"][0]

        # A subscriber verifies authorship against the owner's published identity key.
        r = await subscriber.post("/crypto/keys/batch", json={"user_ids": [str(owner_id)]})
        owner_signing_pub = r.json()["data"][0]["signing_public_key"]

        from app.domains.crypto.reference.primitives import b64u_decode
        assert verify_channel_post(
            signing_public=b64u_decode(owner_signing_pub),
            signature=fetched["channel_post"]["sig"],
            chat_id=chat_id, sender_id=owner_id,
            post_id=uuid.UUID(fetched["channel_post"]["post_id"]),
            content=fetched["channel_post"]["content"],
        )
        assert fetched["channel_post"]["content"] == ANNOUNCEMENT
    finally:
        await owner.aclose()
        await subscriber.aclose()


async def test_subscribers_cannot_post():
    """The gap that made channels meaningless: any member could post."""
    owner, owner_id = await _register_user()
    subscriber, subscriber_id = await _register_user()
    try:
        await _publish_identity(owner, owner_id)
        _, sub_keys = await _publish_identity(subscriber, subscriber_id)

        chat_id = await _channel_with(owner, [subscriber_id])

        r = await subscriber.post("/messages/", json={
            "chat_id": str(chat_id), "channel_post": _post(sub_keys, chat_id, subscriber_id),
        })
        assert r.status_code == 403
        assert r.json()["error_code"] == "CHANNEL_POST_FORBIDDEN"
    finally:
        await owner.aclose()
        await subscriber.aclose()


async def test_admin_can_post():
    owner, owner_id = await _register_user()
    admin, admin_id = await _register_user()
    try:
        await _publish_identity(owner, owner_id)
        _, admin_keys = await _publish_identity(admin, admin_id)

        chat_id = await _channel_with(owner, [admin_id])

        r = await owner.post(f"/chats/{chat_id}/change-role", json={
            "user_id": str(admin_id), "role": "admin",
        })
        assert r.status_code == 200, r.text

        r = await admin.post("/messages/", json={
            "chat_id": str(chat_id), "channel_post": _post(admin_keys, chat_id, admin_id),
        })
        assert r.status_code == 200, r.text
    finally:
        await owner.aclose()
        await admin.aclose()


async def test_forged_post_signature_is_rejected():
    owner, owner_id = await _register_user()
    subscriber, subscriber_id = await _register_user()
    try:
        await _publish_identity(owner, owner_id)
        chat_id = await _channel_with(owner, [subscriber_id])

        impostor = generate_identity(uuid.uuid4(), uuid.uuid4())

        r = await owner.post("/messages/", json={
            "chat_id": str(chat_id), "channel_post": _post(impostor, chat_id, owner_id),
        })
        assert r.status_code == 400
        assert r.json()["error_code"] == "INVALID_POST_SIGNATURE"
    finally:
        await owner.aclose()
        await subscriber.aclose()


async def test_channel_requires_a_signed_post_not_plaintext():
    owner, owner_id = await _register_user()
    try:
        await _publish_identity(owner, owner_id)
        chat_id = await _channel_with(owner, [])

        r = await owner.post("/messages/", json={
            "chat_id": str(chat_id), "encrypted_content": "unsigned announcement",
        })
        assert r.status_code == 400
        assert r.json()["error_code"] == "CHANNEL_POST_REQUIRED"
    finally:
        await owner.aclose()


async def test_channels_cannot_enable_end_to_end_encryption():
    """Refused explicitly rather than silently producing a scheme that cannot scale."""
    owner, owner_id = await _register_user()
    try:
        await _publish_identity(owner, owner_id)
        chat_id = await _channel_with(owner, [])

        r = await owner.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code in (400, 409)
    finally:
        await owner.aclose()
