"""End-to-end group key distribution.

The headline test walks the whole protocol: enable encryption, fetch the roster, verify the member
set hash, wrap a chain key for every member, publish, then have the other member fetch their grant,
unwrap it and decrypt a real message.
"""
import uuid

from app.domains.crypto.reference.envelope import open_message, seal_message
from app.domains.crypto.reference.grants import (
    compute_member_set_hash,
    sign_distribution,
    unwrap_chain_key,
    wrap_chain_key,
)
from app.domains.crypto.reference.identity import generate_identity, unwrap_private_bundle
from app.domains.crypto.reference.primitives import b64u_decode, b64u_encode
from app.domains.crypto.reference.ratchet import ReceiverChain, SenderChain, generate_chain_key

from tests.crypto.test_identity_api import _register_user

PASSWORD = "TestPassw0rd!"
SECRET = b"the group secret nobody else should read"


async def _publish_identity(client, user_id):
    """Register a device identity and keep the private halves locally, as a real client would."""
    device_id = uuid.uuid4()
    bundle = generate_identity(user_id, device_id)

    from app.domains.crypto.reference.identity import wrap_private_bundle
    wrapped, kdf = wrap_private_bundle(bundle, PASSWORD)

    r = await client.post("/crypto/identity", json={
        "device_id": str(device_id),
        "display_name": "test",
        "identity_public_key": b64u_encode(bundle.identity_public),
        "signing_public_key": b64u_encode(bundle.signing_public),
        "identity_key_signature": b64u_encode(bundle.identity_key_signature),
        "encrypted_private_bundle": wrapped,
        "kdf_params": kdf,
    })
    assert r.status_code == 200, r.text
    return device_id, bundle


async def _group_with(alice, bob_id, title="Crypto Group"):
    r = await alice.post("/chats/group", json={
        "title": title, "description": "d", "participant_ids": [str(bob_id)],
    })
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["id"])


async def test_full_group_key_distribution_and_message_exchange():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        bob_device, bob_keys = await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)

        # --- owner enables encryption ---
        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 200, r.text
        epoch_number = r.json()["data"]["epoch"]
        assert epoch_number == 1
        assert r.json()["data"]["member_count"] == 2

        # --- alice fetches the roster and verifies the member set commitment ---
        r = await alice.get(f"/crypto/chats/{chat_id}/roster")
        assert r.status_code == 200, r.text
        roster = r.json()["data"]

        recomputed = compute_member_set_hash([m["device_id"] for m in roster["members"]])
        assert recomputed == roster["member_set_hash"], \
            "client-side verification must match; a mismatch means a ghost device"

        # --- alice mints a chain and wraps it for every member device ---
        chain_key = generate_chain_key()
        sender_key_id = uuid.uuid4()
        chain_identity = generate_identity(alice_id, alice_device)

        grants = []
        for member in roster["members"]:
            recipient_pub = b64u_decode(
                member["signed_prekey_public"] or member["identity_public_key"]
            )
            eph, wrapped = wrap_chain_key(
                chain_key=chain_key, chain_start_index=0, recipient_public=recipient_pub,
                chat_id=chat_id, epoch=epoch_number, sender_key_id=sender_key_id,
                sender_device_id=alice_device,
                recipient_device_id=uuid.UUID(member["device_id"]),
            )
            grants.append({
                "recipient_device_id": member["device_id"],
                "wrap_algorithm": "x25519_hkdf_sha256_aes256gcm_v1",
                "ephemeral_public_key": eph,
                "wrapped_chain_key": wrapped,
            })

        signature = sign_distribution(
            identity_signing_private=alice_keys.signing_private,
            chat_id=chat_id, epoch=epoch_number, sender_key_id=sender_key_id,
            chain_signing_public=chain_identity.signing_public, chain_start_index=0,
        )

        r = await alice.post(f"/crypto/chats/{chat_id}/epochs/{epoch_number}/sender-keys", json={
            "sender_device_id": str(alice_device),
            "sender_key_id": str(sender_key_id),
            "algorithm": "hkdf_sha256_aes256gcm_v1",
            "signing_public_key": b64u_encode(chain_identity.signing_public),
            "chain_start_index": 0,
            "signature": b64u_encode(signature),
            "grants": grants,
        })
        assert r.status_code == 200, r.text
        assert r.json()["data"]["grant_count"] == 2

        # --- alice sends a sealed message ---
        sender = SenderChain(chain_key)
        mk, nonce, idx = sender.next_message_key()
        envelope = seal_message(
            message_key=mk, nonce=nonce, signing_private=chain_identity.signing_private,
            chat_id=chat_id, epoch=epoch_number, sender_id=alice_id,
            sender_key_id=sender_key_id, chain_index=idx, plaintext=SECRET,
        )
        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 200, r.text

        # --- bob fetches keys, unwraps his grant, and decrypts ---
        r = await bob.get(f"/crypto/chats/{chat_id}/keys")
        assert r.status_code == 200, r.text
        keys = r.json()["data"]

        assert keys["crypto_mode"] == "sender_keys_v1"
        assert keys["current_epoch"] == 1
        assert len(keys["distributions"]) == 1

        dist = keys["distributions"][0]
        assert dist["grant"] is not None, "bob must have received a wrapped copy"

        recovered_chain, start_index = unwrap_chain_key(
            wrapped=dist["grant"]["wrapped_chain_key"],
            ephemeral_public=dist["grant"]["ephemeral_public_key"],
            recipient_private=bob_keys.identity_private,
            chat_id=chat_id, epoch=dist["epoch"],
            sender_key_id=uuid.UUID(dist["sender_key_id"]),
            sender_device_id=uuid.UUID(dist["sender_device_id"]),
            recipient_device_id=bob_device,
        )
        assert recovered_chain == chain_key
        assert start_index == 0

        r = await bob.get(f"/chats/{chat_id}/messages")
        fetched = r.json()["data"][0]

        plaintext = open_message(
            message_key=ReceiverChain(recovered_chain).message_key_for(fetched["envelope"]["idx"])[0],
            envelope=fetched["envelope"], chat_id=chat_id, sender_id=alice_id,
            signing_public=b64u_decode(dist["signing_public_key"]),
        )
        assert plaintext == SECRET
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_only_owner_can_enable_encryption():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)

        r = await bob.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 403

        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 200, r.text

        # Second enable is rejected rather than silently resetting the epoch chain.
        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 409
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_non_member_cannot_read_chat_keys():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    outsider, _ = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        r = await outsider.get(f"/crypto/chats/{chat_id}/keys")
        assert r.status_code == 403

        r = await outsider.get(f"/crypto/chats/{chat_id}/roster")
        assert r.status_code == 403
    finally:
        await alice.aclose()
        await bob.aclose()
        await outsider.aclose()


async def test_partial_grant_upload_is_rejected():
    """Omitting a member would silently exclude them; that must fail loudly."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        chain_key = generate_chain_key()
        sender_key_id = uuid.uuid4()
        chain_identity = generate_identity(alice_id, alice_device)

        # Wrap for alice only, omitting bob.
        eph, wrapped = wrap_chain_key(
            chain_key=chain_key, chain_start_index=0,
            recipient_public=alice_keys.identity_public,
            chat_id=chat_id, epoch=1, sender_key_id=sender_key_id,
            sender_device_id=alice_device, recipient_device_id=alice_device,
        )
        signature = sign_distribution(
            identity_signing_private=alice_keys.signing_private,
            chat_id=chat_id, epoch=1, sender_key_id=sender_key_id,
            chain_signing_public=chain_identity.signing_public, chain_start_index=0,
        )

        r = await alice.post(f"/crypto/chats/{chat_id}/epochs/1/sender-keys", json={
            "sender_device_id": str(alice_device),
            "sender_key_id": str(sender_key_id),
            "algorithm": "hkdf_sha256_aes256gcm_v1",
            "signing_public_key": b64u_encode(chain_identity.signing_public),
            "chain_start_index": 0,
            "signature": b64u_encode(signature),
            "grants": [{
                "recipient_device_id": str(alice_device),
                "wrap_algorithm": "x25519_hkdf_sha256_aes256gcm_v1",
                "ephemeral_public_key": eph,
                "wrapped_chain_key": wrapped,
            }],
        })
        assert r.status_code == 400
        assert r.json()["error_code"] == "GRANT_SET_MISMATCH"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_forged_distribution_signature_is_rejected():
    """The server verifies the sender's identity vouches for the chain signing key."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        bob_device, bob_keys = await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        chain_key = generate_chain_key()
        sender_key_id = uuid.uuid4()
        chain_identity = generate_identity(alice_id, alice_device)
        impostor = generate_identity(uuid.uuid4(), uuid.uuid4())

        grants = []
        for device_id, keys in ((alice_device, alice_keys), (bob_device, bob_keys)):
            eph, wrapped = wrap_chain_key(
                chain_key=chain_key, chain_start_index=0,
                recipient_public=keys.identity_public,
                chat_id=chat_id, epoch=1, sender_key_id=sender_key_id,
                sender_device_id=alice_device, recipient_device_id=device_id,
            )
            grants.append({
                "recipient_device_id": str(device_id),
                "wrap_algorithm": "x25519_hkdf_sha256_aes256gcm_v1",
                "ephemeral_public_key": eph,
                "wrapped_chain_key": wrapped,
            })

        # Signed by someone who is not alice.
        signature = sign_distribution(
            identity_signing_private=impostor.signing_private,
            chat_id=chat_id, epoch=1, sender_key_id=sender_key_id,
            chain_signing_public=chain_identity.signing_public, chain_start_index=0,
        )

        r = await alice.post(f"/crypto/chats/{chat_id}/epochs/1/sender-keys", json={
            "sender_device_id": str(alice_device),
            "sender_key_id": str(sender_key_id),
            "algorithm": "hkdf_sha256_aes256gcm_v1",
            "signing_public_key": b64u_encode(chain_identity.signing_public),
            "chain_start_index": 0,
            "signature": b64u_encode(signature),
            "grants": grants,
        })
        assert r.status_code == 400
        assert r.json()["error_code"] == "INVALID_DISTRIBUTION_SIGNATURE"
    finally:
        await alice.aclose()
        await bob.aclose()
