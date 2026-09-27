"""End-to-end tests for signed-prekey rotation (`PUT /crypto/identity/prekey`).

Rotation was disabled for a full incident cycle: publishing a prekey with no private half stored
anywhere made every grant addressed to that device permanently unopenable. These cover the fix —
the public prekey and the re-sealed bundle rotate together, atomically — plus the same
signature-verification failure modes `test_identity_api.py` covers for the publish path, and the
backward-compatibility story for bundles sealed before this existed.
"""
import uuid
from dataclasses import replace

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

from app.domains.crypto.reference.identity import (
    generate_identity,
    identity_binding_message,
    prekey_binding_message,
    unwrap_private_bundle,
    wrap_private_bundle,
)
from app.domains.crypto.reference.primitives import b64u_encode

from tests.crypto.test_identity_api import _register_user

PASSWORD = "pw"


def _new_prekey(user_id, device_id, signing_private_raw: bytes):
    """Mint a fresh X25519 prekey and bind it with the device's existing signing key."""
    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    priv_raw = priv.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())

    signer = Ed25519PrivateKey.from_private_bytes(signing_private_raw)
    signature = signer.sign(prekey_binding_message(user_id, device_id, pub))

    return priv_raw, pub, signature


async def _register_without_prekey(client, user_id, device_id):
    """A device published with no prekey at all — the state every account starts in."""
    bundle = generate_identity(user_id, device_id, with_prekey=False)
    wrapped, kdf_params = wrap_private_bundle(bundle, PASSWORD)

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
    assert r.json()["data"]["signed_prekey_public"] is None
    return bundle


async def test_rotation_round_trips_the_prekey_private_through_the_bundle():
    """The fix in one test: after rotation, the stored bundle actually contains the private half
    the client generated, and it can be recovered with the same password used to seal it."""
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        bundle = await _register_without_prekey(client, user_id, device_id)

        prekey_private, prekey_public, prekey_sig = _new_prekey(
            user_id, device_id, bundle.signing_private
        )
        rotated_bundle = replace(
            bundle,
            prekey_private=prekey_private,
            prekey_public=prekey_public,
            signed_prekey_signature=prekey_sig,
        )
        new_wrapped, new_kdf = wrap_private_bundle(rotated_bundle, PASSWORD)

        r = await client.put("/crypto/identity/prekey", json={
            "device_id": str(device_id),
            "signed_prekey_public": b64u_encode(prekey_public),
            "signed_prekey_signature": b64u_encode(prekey_sig),
            "encrypted_private_bundle": new_wrapped,
            "kdf_params": new_kdf,
        })
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["signed_prekey_public"] == b64u_encode(prekey_public)

        # Rotation must not touch the identity keypair or supersede the key version.
        assert data["identity_public_key"] == b64u_encode(bundle.identity_public)
        assert data["version"] == 1

        r = await client.get("/crypto/identity/me")
        assert r.status_code == 200, r.text
        mine = r.json()["data"]
        assert len(mine) == 1, "rotation must not create a second row"
        assert mine[0]["signed_prekey_public"] == b64u_encode(prekey_public)

        recovered = unwrap_private_bundle(
            mine[0]["encrypted_private_bundle"], mine[0]["kdf_params"], PASSWORD
        )
        assert recovered["prekey_private"] == prekey_private
        assert recovered["identity_private"] == bundle.identity_private
        assert recovered["signing_private"] == bundle.signing_private
    finally:
        await client.aclose()


async def test_rotation_rejects_a_signature_from_the_wrong_key():
    """A structurally valid Ed25519 signature, over the right message, but by a key that is not
    this device's identity signing key must be refused."""
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        bundle = await _register_without_prekey(client, user_id, device_id)

        _, prekey_public, _ = _new_prekey(user_id, device_id, bundle.signing_private)
        attacker_sig = Ed25519PrivateKey.generate().sign(
            prekey_binding_message(user_id, device_id, prekey_public)
        )
        # The bundle content is irrelevant to this check — the signature is rejected before it
        # would ever be written — so re-sealing the original, untouched bundle is enough to pass
        # schema validation.
        wrapped, kdf_params = wrap_private_bundle(bundle, PASSWORD)

        r = await client.put("/crypto/identity/prekey", json={
            "device_id": str(device_id),
            "signed_prekey_public": b64u_encode(prekey_public),
            "signed_prekey_signature": b64u_encode(attacker_sig),
            "encrypted_private_bundle": wrapped,
            "kdf_params": kdf_params,
        })
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "INVALID_KEY_SIGNATURE"
    finally:
        await client.aclose()


async def test_rotation_rejects_a_signature_over_the_wrong_domain_separator():
    """Signing the identity-binding message instead of the prekey-binding one must also fail:
    the two share a shape (a 32-byte X25519 key for this user/device) but not a domain separator,
    and that is exactly what the separator exists to prevent."""
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        bundle = await _register_without_prekey(client, user_id, device_id)

        _, prekey_public, _ = _new_prekey(user_id, device_id, bundle.signing_private)
        signer = Ed25519PrivateKey.from_private_bytes(bundle.signing_private)
        crossed_sig = signer.sign(identity_binding_message(user_id, device_id, prekey_public))
        wrapped, kdf_params = wrap_private_bundle(bundle, PASSWORD)

        r = await client.put("/crypto/identity/prekey", json={
            "device_id": str(device_id),
            "signed_prekey_public": b64u_encode(prekey_public),
            "signed_prekey_signature": b64u_encode(crossed_sig),
            "encrypted_private_bundle": wrapped,
            "kdf_params": kdf_params,
        })
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "INVALID_KEY_SIGNATURE"
    finally:
        await client.aclose()


async def test_rotation_rejects_an_unknown_device():
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        bundle = generate_identity(user_id, device_id)
        _, prekey_public, prekey_sig = _new_prekey(user_id, device_id, bundle.signing_private)
        wrapped, kdf_params = wrap_private_bundle(bundle, PASSWORD)

        r = await client.put("/crypto/identity/prekey", json={
            "device_id": str(device_id),
            "signed_prekey_public": b64u_encode(prekey_public),
            "signed_prekey_signature": b64u_encode(prekey_sig),
            "encrypted_private_bundle": wrapped,
            "kdf_params": kdf_params,
        })
        assert r.status_code == 404, r.text
        assert r.json()["error_code"] == "DEVICE_NOT_FOUND"
    finally:
        await client.aclose()


async def test_rotation_rejects_another_users_device():
    """Rotation is scoped to the caller's own device — the lookup filters on user_id too."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        bundle = await _register_without_prekey(alice, alice_id, device_id)

        _, prekey_public, prekey_sig = _new_prekey(alice_id, device_id, bundle.signing_private)
        wrapped, kdf_params = wrap_private_bundle(bundle, PASSWORD)

        r = await bob.put("/crypto/identity/prekey", json={
            "device_id": str(device_id),
            "signed_prekey_public": b64u_encode(prekey_public),
            "signed_prekey_signature": b64u_encode(prekey_sig),
            "encrypted_private_bundle": wrapped,
            "kdf_params": kdf_params,
        })
        assert r.status_code == 404, r.text
        assert r.json()["error_code"] == "DEVICE_NOT_FOUND"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_rotation_of_a_pre_fix_bundle_still_unwraps_after_rotating():
    """Backward compatibility for an account that registered before this fix: its bundle has no
    `prekey_private` at all. Rotation must still work, and the re-sealed bundle it produces is a
    normal current-format bundle from that point on — there is nothing to migrate server-side,
    since the server never had the plaintext to migrate in the first place."""
    client, user_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        bundle = await _register_without_prekey(client, user_id, device_id)

        # Confirm the starting bundle really is the old shape: unwrapping it yields no prekey.
        r = await client.get("/crypto/identity/me")
        mine = r.json()["data"][0]
        pre_rotation = unwrap_private_bundle(
            mine["encrypted_private_bundle"], mine["kdf_params"], PASSWORD
        )
        assert "prekey_private" not in pre_rotation

        prekey_private, prekey_public, prekey_sig = _new_prekey(
            user_id, device_id, bundle.signing_private
        )
        rotated_bundle = replace(
            bundle,
            prekey_private=prekey_private,
            prekey_public=prekey_public,
            signed_prekey_signature=prekey_sig,
        )
        new_wrapped, new_kdf = wrap_private_bundle(rotated_bundle, PASSWORD)

        r = await client.put("/crypto/identity/prekey", json={
            "device_id": str(device_id),
            "signed_prekey_public": b64u_encode(prekey_public),
            "signed_prekey_signature": b64u_encode(prekey_sig),
            "encrypted_private_bundle": new_wrapped,
            "kdf_params": new_kdf,
        })
        assert r.status_code == 200, r.text

        r = await client.get("/crypto/identity/me")
        mine = r.json()["data"][0]
        post_rotation = unwrap_private_bundle(
            mine["encrypted_private_bundle"], mine["kdf_params"], PASSWORD
        )
        assert post_rotation["prekey_private"] == prekey_private
    finally:
        await client.aclose()
