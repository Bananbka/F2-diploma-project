"""Epoch rotation on membership change, and enforcement of epochs on the send path."""
import uuid

from app.domains.crypto.reference.envelope import seal_message
from app.domains.crypto.reference.grants import sign_distribution, wrap_chain_key
from app.domains.crypto.reference.identity import generate_identity
from app.domains.crypto.reference.primitives import b64u_decode, b64u_encode
from app.domains.crypto.reference.ratchet import SenderChain, generate_chain_key

from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_identity_api import _register_user


async def _publish_chain(client, chat_id, epoch, sender_id, sender_device, identity_keys):
    """Mint a chain, wrap it for every roster member, publish it. Returns (chain_key, skid, chain)."""
    r = await client.get(f"/crypto/chats/{chat_id}/roster")
    assert r.status_code == 200, r.text
    roster = r.json()["data"]

    chain_key = generate_chain_key()
    sender_key_id = uuid.uuid4()
    chain_identity = generate_identity(sender_id, sender_device)

    grants = []
    for member in roster["members"]:
        recipient_pub = b64u_decode(
            member["signed_prekey_public"] or member["identity_public_key"]
        )
        eph, wrapped = wrap_chain_key(
            chain_key=chain_key, chain_start_index=0, recipient_public=recipient_pub,
            chat_id=chat_id, epoch=epoch, sender_key_id=sender_key_id,
            sender_device_id=sender_device,
            recipient_device_id=uuid.UUID(member["device_id"]),
        )
        grants.append({
            "recipient_device_id": member["device_id"],
            "wrap_algorithm": "x25519_hkdf_sha256_aes256gcm_v1",
            "ephemeral_public_key": eph,
            "wrapped_chain_key": wrapped,
        })

    signature = sign_distribution(
        identity_signing_private=identity_keys.signing_private,
        chat_id=chat_id, epoch=epoch, sender_key_id=sender_key_id,
        chain_signing_public=chain_identity.signing_public, chain_start_index=0,
    )

    r = await client.post(f"/crypto/chats/{chat_id}/epochs/{epoch}/sender-keys", json={
        "sender_device_id": str(sender_device),
        "sender_key_id": str(sender_key_id),
        "algorithm": "hkdf_sha256_aes256gcm_v1",
        "signing_public_key": b64u_encode(chain_identity.signing_public),
        "chain_start_index": 0,
        "signature": b64u_encode(signature),
        "grants": grants,
    })
    assert r.status_code == 200, r.text

    return chain_key, sender_key_id, chain_identity


def _seal(chain, chat_id, epoch, sender_id, skid, chain_identity, body=b"hi"):
    mk, nonce, idx = chain.next_message_key()
    return seal_message(
        message_key=mk, nonce=nonce, signing_private=chain_identity.signing_private,
        chat_id=chat_id, epoch=epoch, sender_id=sender_id,
        sender_key_id=skid, chain_index=idx, plaintext=body,
    )


async def test_removing_a_member_rotates_the_epoch():
    """The mandatory trigger: a removed member must not be able to read what comes next."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)
        await _publish_identity(carol, carol_id)

        r = await alice.post("/chats/group", json={
            "title": "G", "description": "d",
            "participant_ids": [str(bob_id), str(carol_id)],
        })
        chat_id = uuid.UUID(r.json()["data"]["id"])

        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.json()["data"]["epoch"] == 1
        assert r.json()["data"]["member_count"] == 3

        r = await alice.post(f"/chats/{chat_id}/delete-participants",
                             json={"user_ids": [str(carol_id)]})
        assert r.status_code == 200, r.text

        r = await alice.get(f"/crypto/chats/{chat_id}/keys")
        keys = r.json()["data"]
        assert keys["current_epoch"] == 2, "removal must open a new epoch"

        epochs = {e["epoch"]: e for e in keys["epochs"]}
        assert epochs[1]["closed_at"] is not None, "old epoch must be closed"
        assert epochs[2]["reason"] == "member_removed"
        assert epochs[2]["member_count"] == 2

        # Carol is gone and can no longer reach the chat at all.
        r = await carol.get(f"/crypto/chats/{chat_id}/keys")
        assert r.status_code == 403
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_leaving_rotates_the_epoch():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        r = await bob.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 200, r.text

        r = await alice.get(f"/crypto/chats/{chat_id}/keys")
        keys = r.json()["data"]
        assert keys["current_epoch"] == 2
        assert keys["epochs"][-1]["member_count"] == 1

        r = await bob.get(f"/chats/{chat_id}/messages")
        assert r.status_code == 403, "a departed member loses access"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_owner_cannot_leave_and_private_chats_cannot_be_left():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 400
        assert r.json()["error_code"] == "OWNER_CANNOT_LEAVE"

        r = await alice.post("/chats/private", json={"target_user_id": str(bob_id)})
        private_id = r.json()["data"]["id"]

        r = await alice.post(f"/chats/{private_id}/leave")
        assert r.status_code == 400
        assert r.json()["error_code"] == "INVALID_CHAT_TYPE"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_adding_a_member_rotates_and_floors_their_history():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)
        await _publish_identity(carol, carol_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        chain_key, skid, chain_identity = await _publish_chain(
            alice, chat_id, 1, alice_id, alice_device, alice_keys
        )
        chain = SenderChain(chain_key)

        r = await alice.post("/messages/", json={
            "chat_id": str(chat_id),
            "envelope": _seal(chain, chat_id, 1, alice_id, skid, chain_identity, b"before carol"),
        })
        assert r.status_code == 200, r.text

        r = await alice.post(f"/chats/{chat_id}/add-participants",
                             json={"user_ids": [str(carol_id)]})
        assert r.status_code == 200, r.text

        r = await alice.get(f"/crypto/chats/{chat_id}/keys")
        assert r.json()["data"]["current_epoch"] == 2

        # Carol joined under JOINED visibility, so pre-join traffic is floored out entirely —
        # she gets no ciphertext, not merely ciphertext she cannot read.
        r = await carol.get(f"/chats/{chat_id}/messages")
        assert r.status_code == 200, r.text
        assert r.json()["data"] == []

        r = await carol.get(f"/crypto/chats/{chat_id}/keys")
        assert r.json()["data"]["my_join_epoch"] == 2

        # Alice still sees the history she sent.
        r = await alice.get(f"/chats/{chat_id}/messages")
        assert len(r.json()["data"]) == 1
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_send_is_rejected_under_a_stale_epoch():
    """After a rotation, a message keyed to the old epoch must not be accepted."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)
        await _publish_identity(carol, carol_id)

        r = await alice.post("/chats/group", json={
            "title": "G", "description": "d",
            "participant_ids": [str(bob_id), str(carol_id)],
        })
        chat_id = uuid.UUID(r.json()["data"]["id"])
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        chain_key, skid, chain_identity = await _publish_chain(
            alice, chat_id, 1, alice_id, alice_device, alice_keys
        )
        chain = SenderChain(chain_key)

        # Works under the live epoch.
        r = await alice.post("/messages/", json={
            "chat_id": str(chat_id),
            "envelope": _seal(chain, chat_id, 1, alice_id, skid, chain_identity),
        })
        assert r.status_code == 200, r.text

        # Removing carol rotates to epoch 2.
        await alice.post(f"/chats/{chat_id}/delete-participants",
                         json={"user_ids": [str(carol_id)]})

        r = await alice.post("/messages/", json={
            "chat_id": str(chat_id),
            "envelope": _seal(chain, chat_id, 1, alice_id, skid, chain_identity, b"leak?"),
        })
        assert r.status_code == 409
        assert r.json()["error_code"] == "EPOCH_STALE"
        assert r.json()["details"]["current_epoch"] == 2
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_send_is_rejected_without_a_published_sender_key():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        chain_identity = generate_identity(alice_id, alice_device)
        chain = SenderChain(generate_chain_key())

        r = await alice.post("/messages/", json={
            "chat_id": str(chat_id),
            "envelope": _seal(chain, chat_id, 1, alice_id, uuid.uuid4(), chain_identity),
        })
        assert r.status_code == 409
        assert r.json()["error_code"] == "SENDER_KEY_MISSING"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_encrypted_chat_rejects_plaintext():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        r = await alice.post("/messages/", json={
            "chat_id": str(chat_id), "encrypted_content": "plaintext sneaking in",
        })
        assert r.status_code == 400
        assert r.json()["error_code"] == "ENVELOPE_REQUIRED"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_forged_message_signature_is_rejected():
    """The server verifies attribution even though it cannot read the message."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        chain_key, skid, _ = await _publish_chain(
            alice, chat_id, 1, alice_id, alice_device, alice_keys
        )

        # Seal with a chain key nobody vouched for.
        impostor = generate_identity(uuid.uuid4(), uuid.uuid4())
        chain = SenderChain(chain_key)

        r = await alice.post("/messages/", json={
            "chat_id": str(chat_id),
            "envelope": _seal(chain, chat_id, 1, alice_id, skid, impostor),
        })
        assert r.status_code == 400
        assert r.json()["error_code"] == "INVALID_MESSAGE_SIGNATURE"
    finally:
        await alice.aclose()
        await bob.aclose()
