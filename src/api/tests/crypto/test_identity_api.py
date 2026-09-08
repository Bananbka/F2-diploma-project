"""End-to-end tests for the /crypto identity endpoints against the running app."""
import uuid

import httpx
import pytest
import redis.asyncio as aioredis

from app.core.config import settings
from app.domains.crypto.reference.identity import generate_identity, wrap_private_bundle
from app.domains.crypto.reference.primitives import b64u_encode

BASE = "http://localhost:8000"


async def _register_user() -> tuple[httpx.AsyncClient, uuid.UUID]:
    """Register + verify + login, returning an authenticated client."""
    suffix = uuid.uuid4().hex[:10]
    email = f"crypto{suffix}@example.com"
    password = "TestPassw0rd!"

    client = httpx.AsyncClient(base_url=BASE, timeout=30.0)

    r = await client.post("/auth/register", json={
        "full_name": "Crypto Test",
        "username": f"crypto{suffix}",
        "password": password,
        "email": email,
        "phone_number": f"+38050{uuid.uuid4().int % 10_000_000:07d}",
        "public_key": "legacy",
        "encrypted_private_key": "legacy",
    })
    assert r.status_code == 200, r.text
    user_id = uuid.UUID(r.json()["data"]["id"])

    rc = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    otp = await rc.get(f"email-verification:{email}")
    await rc.aclose()

    r = await client.post("/auth/verify-email", json={"email": email, "otp": otp})
    assert r.status_code == 200, r.text

    r = await client.post("/auth/login", json={"username": f"crypto{suffix}", "password": password})
    assert r.status_code == 200, r.text

    return client, user_id


def _publish_payload(user_id: uuid.UUID, device_id: uuid.UUID, password="pw") -> dict:
    bundle = generate_identity(user_id, device_id)
    wrapped, kdf_params = wrap_private_bundle(bundle, password)

    return {
        "device_id": str(device_id),
        "display_name": "test-device",
        "identity_public_key": b64u_encode(bundle.identity_public),
        "signing_public_key": b64u_encode(bundle.signing_public),
        "identity_key_signature": b64u_encode(bundle.identity_key_signature),
        "encrypted_private_bundle": wrapped,
        "kdf_params": kdf_params,
    }


async def test_publish_and_fetch_own_identity():
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        r = await client.post("/crypto/identity", json=_publish_payload(user_id, device_id))
        assert r.status_code == 200, r.text

        data = r.json()["data"]
        assert data["version"] == 1
        assert data["device_id"] == str(device_id)
        # The public response must never leak the wrapped private bundle.
        assert "encrypted_private_bundle" not in data

        r = await client.get("/crypto/identity/me")
        assert r.status_code == 200
        mine = r.json()["data"]
        assert len(mine) == 1
        # Own view does include it, so the client can unlock after login.
        assert mine[0]["encrypted_private_bundle"]
        assert mine[0]["kdf_params"]["kdf"] == "argon2id"
    finally:
        await client.aclose()


async def test_forged_signature_is_rejected():
    """The server verifies the Ed25519 binding, so a mismatched key pair cannot be published."""
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        payload = _publish_payload(user_id, device_id)

        # Swap in a different X25519 key while keeping the original signature.
        attacker = generate_identity(uuid.uuid4(), uuid.uuid4())
        payload["identity_public_key"] = b64u_encode(attacker.identity_public)

        r = await client.post("/crypto/identity", json=payload)
        assert r.status_code == 400
        assert r.json()["error_code"] == "INVALID_KEY_SIGNATURE"
    finally:
        await client.aclose()


async def test_weak_kdf_params_are_rejected():
    """Guards against a client downgrading to a weak or absent key derivation."""
    client, user_id = await _register_user()
    try:
        payload = _publish_payload(user_id, uuid.uuid4())
        payload["kdf_params"] = {"kdf": "argon2id", "m": 8, "t": 1, "p": 1,
                                 "salt": "AAAA", "nonce": "AAAA"}

        r = await client.post("/crypto/identity", json=payload)
        assert r.status_code == 422, r.text
    finally:
        await client.aclose()


async def test_rotation_supersedes_previous_key():
    """Rotation must not overwrite in place — the old key is retained as revoked."""
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        r = await client.post("/crypto/identity", json=_publish_payload(user_id, device_id))
        assert r.json()["data"]["version"] == 1

        r = await client.post("/crypto/identity", json=_publish_payload(user_id, device_id))
        assert r.status_code == 200, r.text
        assert r.json()["data"]["version"] == 2

        # Exactly one active key survives, enforced by the partial unique index.
        r = await client.get("/crypto/identity/me")
        assert len(r.json()["data"]) == 1
    finally:
        await client.aclose()


async def test_batch_key_fetch_and_safety_number():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        await alice.post("/crypto/identity", json=_publish_payload(alice_id, uuid.uuid4()))
        await bob.post("/crypto/identity", json=_publish_payload(bob_id, uuid.uuid4()))

        r = await alice.post("/crypto/keys/batch", json={"user_ids": [str(alice_id), str(bob_id)]})
        assert r.status_code == 200, r.text
        keys = r.json()["data"]
        assert len(keys) == 2
        assert all("encrypted_private_bundle" not in k for k in keys), "batch must not leak private bundles"

        # Both sides must derive the identical fingerprint, or verification is meaningless.
        ra = await alice.get(f"/crypto/safety-number/{bob_id}")
        rb = await bob.get(f"/crypto/safety-number/{alice_id}")
        assert ra.status_code == 200 and rb.status_code == 200
        assert ra.json()["data"]["safety_number"] == rb.json()["data"]["safety_number"]
        assert len(ra.json()["data"]["safety_number"].split(" ")) == 12
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_device_cannot_be_hijacked_by_another_user():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        r = await alice.post("/crypto/identity", json=_publish_payload(alice_id, device_id))
        assert r.status_code == 200

        # Bob signs correctly for himself but reuses Alice's device id.
        r = await bob.post("/crypto/identity", json=_publish_payload(bob_id, device_id))
        assert r.status_code == 409
        assert r.json()["error_code"] == "DEVICE_CONFLICT"
    finally:
        await alice.aclose()
        await bob.aclose()


@pytest.mark.asyncio
async def test_prekey_rotation_requires_a_valid_signature():
    """The prekey signature must verify against the device's existing identity key.

    Grants prefer the signed prekey over the identity key as the ECDH recipient, so a prekey the
    server accepts without checking is a key-substitution hole: anyone who can reach this endpoint
    could swap in a key they hold and receive every subsequent sender key.
    """
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PublicFormat, PrivateFormat

    from app.domains.crypto.reference.identity import prekey_binding_message

    client, user_id = await _register_user()
    device_id = uuid.uuid4()

    bundle = generate_identity(user_id, device_id)
    wrapped, kdf_params = wrap_private_bundle(bundle, "pw")

    r = await client.post("/crypto/identity", json={
        "device_id": str(device_id),
        "display_name": "test-device",
        "identity_public_key": b64u_encode(bundle.identity_public),
        "signing_public_key": b64u_encode(bundle.signing_public),
        "identity_key_signature": b64u_encode(bundle.identity_key_signature),
        "encrypted_private_bundle": wrapped,
        "kdf_params": kdf_params,
    })
    assert r.status_code == 200, r.text

    prekey_private = X25519PrivateKey.generate()
    prekey_public = prekey_private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

    signing_private = Ed25519PrivateKey.from_private_bytes(bundle.signing_private)
    good_sig = signing_private.sign(prekey_binding_message(user_id, device_id, prekey_public))

    # A signature by a key that is not this device's identity key must be refused, even though it is
    # a structurally valid Ed25519 signature over the right message.
    attacker_sig = Ed25519PrivateKey.generate().sign(
        prekey_binding_message(user_id, device_id, prekey_public)
    )

    r = await client.put("/crypto/identity/prekey", json={
        "device_id": str(device_id),
        "signed_prekey_public": b64u_encode(prekey_public),
        "signed_prekey_signature": b64u_encode(attacker_sig),
    })
    assert r.status_code == 400, r.text
    assert r.json()["error_code"] == "INVALID_KEY_SIGNATURE"

    # Signing the identity-binding message instead must also fail: the two share a shape but not a
    # domain separator, and that is exactly what the separator is for.
    from app.domains.crypto.reference.identity import identity_binding_message
    crossed_sig = signing_private.sign(identity_binding_message(user_id, device_id, prekey_public))

    r = await client.put("/crypto/identity/prekey", json={
        "device_id": str(device_id),
        "signed_prekey_public": b64u_encode(prekey_public),
        "signed_prekey_signature": b64u_encode(crossed_sig),
    })
    assert r.status_code == 400, r.text

    r = await client.put("/crypto/identity/prekey", json={
        "device_id": str(device_id),
        "signed_prekey_public": b64u_encode(prekey_public),
        "signed_prekey_signature": b64u_encode(good_sig),
    })
    assert r.status_code == 200, r.text
    assert r.json()["data"]["signed_prekey_public"] == b64u_encode(prekey_public)

    # Rotation must not disturb the identity key or supersede the key version.
    assert r.json()["data"]["identity_public_key"] == b64u_encode(bundle.identity_public)
    assert r.json()["data"]["version"] == 1

    await client.aclose()
