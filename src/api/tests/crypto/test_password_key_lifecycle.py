"""The change-vs-reset distinction.

Change password must preserve the identity (history stays readable). Reset password cannot —
the wrapped bundle is gone — so it must revoke cleanly rather than leave unusable keys behind.
"""
import uuid

from app.domains.crypto.reference.identity import (
    generate_identity,
    unwrap_private_bundle,
    wrap_private_bundle,
)
from app.domains.crypto.reference.primitives import b64u_encode

from tests.crypto.test_identity_api import _publish_payload, _register_user


async def test_change_password_preserves_keypair_and_history_access():
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        bundle = generate_identity(user_id, device_id)
        wrapped, kdf = wrap_private_bundle(bundle, "TestPassw0rd!")

        payload = {
            "device_id": str(device_id),
            "display_name": "d",
            "identity_public_key": b64u_encode(bundle.identity_public),
            "signing_public_key": b64u_encode(bundle.signing_public),
            "identity_key_signature": b64u_encode(bundle.identity_key_signature),
            "encrypted_private_bundle": wrapped,
            "kdf_params": kdf,
        }
        r = await client.post("/crypto/identity", json=payload)
        assert r.status_code == 200, r.text
        original_public = r.json()["data"]["identity_public_key"]

        # Client re-wraps the SAME private bundle under the new password.
        new_wrapped, new_kdf = wrap_private_bundle(bundle, "BrandNewPassw0rd!")

        r = await client.post("/auth/change-password", json={
            "old_password": "TestPassw0rd!",
            "new_password": "BrandNewPassw0rd!",
            "rewrapped_identities": [{
                "device_id": str(device_id),
                "encrypted_private_bundle": new_wrapped,
                "kdf_params": new_kdf,
            }],
        })
        assert r.status_code == 200, r.text

        r = await client.get("/crypto/identity/me")
        assert r.status_code == 200, r.text
        keys = r.json()["data"]
        assert len(keys) == 1

        # The public key must be untouched: rotating it here would orphan all existing history.
        assert keys[0]["identity_public_key"] == original_public
        assert keys[0]["version"] == 1

        # And the stored bundle must open with the NEW password, yielding the ORIGINAL private key.
        recovered = unwrap_private_bundle(
            keys[0]["encrypted_private_bundle"], keys[0]["kdf_params"], "BrandNewPassw0rd!"
        )
        assert recovered["identity_private"] == bundle.identity_private
        assert recovered["signing_private"] == bundle.signing_private
    finally:
        await client.aclose()


async def test_change_password_rejects_unknown_device():
    client, user_id = await _register_user()
    try:
        await client.post("/crypto/identity", json=_publish_payload(user_id, uuid.uuid4()))

        bundle = generate_identity(user_id, uuid.uuid4())
        wrapped, kdf = wrap_private_bundle(bundle, "x")

        r = await client.post("/auth/change-password", json={
            "old_password": "TestPassw0rd!",
            "new_password": "BrandNewPassw0rd!",
            "rewrapped_identities": [{
                "device_id": str(uuid.uuid4()),   # not this user's device
                "encrypted_private_bundle": wrapped,
                "kdf_params": kdf,
            }],
        })
        assert r.status_code == 400
        assert r.json()["error_code"] == "UNKNOWN_DEVICE"
    finally:
        await client.aclose()


async def test_reset_password_revokes_identity():
    """Reset cannot preserve the identity, so it must revoke rather than strand dead keys."""
    import redis.asyncio as aioredis
    from app.core.config import settings

    client, user_id = await _register_user()
    try:
        await client.post("/crypto/identity", json=_publish_payload(user_id, uuid.uuid4()))
        assert len((await client.get("/crypto/identity/me")).json()["data"]) == 1

        me = (await client.get("/profile/me")).json()["data"]

        r = await client.post("/auth/forgot-password",
                              json={"username": me["username"], "email": me["email"]})
        assert r.status_code == 200, r.text

        rc = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        otp = await rc.get(f"password_reset:{user_id}")
        await rc.aclose()
        assert otp, "reset OTP should be in redis"

        r = await client.post("/auth/reset-password", json={
            "username": me["username"],
            "otp": otp,
            "new_password": "AfterReset123!",
            "new_public_key": "legacy",
            "new_encrypted_private_key": "legacy",
        })
        assert r.status_code == 200, r.text

        # Reset forces a logout, so log back in before checking key state.
        r = await client.post("/auth/login",
                              json={"username": me["username"], "password": "AfterReset123!"})
        assert r.status_code == 200, r.text

        keys = (await client.get("/crypto/identity/me")).json()["data"]
        assert keys == [], "the old identity must be revoked, not left dangling"
    finally:
        await client.aclose()
