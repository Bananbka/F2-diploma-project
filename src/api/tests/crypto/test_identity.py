"""Known-answer and property tests for the v1 identity layer.

These pin the wire format. If a change here breaks a test, that is a protocol change and every
client must be updated in lockstep — it is not a test to "fix".
"""
import uuid

import pytest

from app.domains.crypto.reference.identity import (
    generate_identity,
    safety_number,
    unwrap_private_bundle,
    verify_identity_binding,
    wrap_private_bundle,
)
from app.domains.crypto.reference.primitives import b64u_decode, b64u_encode

USER_A = uuid.UUID("11111111-1111-1111-1111-111111111111")
DEVICE_A = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
USER_B = uuid.UUID("22222222-2222-2222-2222-222222222222")
DEVICE_B = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")


def test_generated_keys_have_correct_lengths():
    b = generate_identity(USER_A, DEVICE_A)

    assert len(b.signing_public) == 32
    assert len(b.identity_public) == 32
    assert len(b.signing_private) == 32
    assert len(b.identity_private) == 32
    assert len(b.identity_key_signature) == 64


def test_identity_binding_verifies():
    b = generate_identity(USER_A, DEVICE_A)

    assert verify_identity_binding(
        USER_A, DEVICE_A, b.identity_public, b.signing_public, b.identity_key_signature
    )


def test_identity_binding_rejects_transplant_to_other_user():
    """A valid (key, signature) pair must not verify under a different user or device."""
    b = generate_identity(USER_A, DEVICE_A)

    assert not verify_identity_binding(
        USER_B, DEVICE_A, b.identity_public, b.signing_public, b.identity_key_signature
    )
    assert not verify_identity_binding(
        USER_A, DEVICE_B, b.identity_public, b.signing_public, b.identity_key_signature
    )


def test_identity_binding_rejects_substituted_x25519_key():
    """The core attack: swap in an attacker's DH key but keep the real signature."""
    victim = generate_identity(USER_A, DEVICE_A)
    attacker = generate_identity(USER_B, DEVICE_B)

    assert not verify_identity_binding(
        USER_A, DEVICE_A,
        attacker.identity_public,          # attacker's key
        victim.signing_public,             # victim's identity
        victim.identity_key_signature,
    )


def test_private_bundle_round_trip():
    b = generate_identity(USER_A, DEVICE_A)
    wrapped, params = wrap_private_bundle(b, "correct horse battery staple")

    out = unwrap_private_bundle(wrapped, params, "correct horse battery staple")

    assert out["signing_private"] == b.signing_private
    assert out["identity_private"] == b.identity_private


def test_private_bundle_rejects_wrong_password():
    b = generate_identity(USER_A, DEVICE_A)
    wrapped, params = wrap_private_bundle(b, "right-password")

    with pytest.raises(Exception):
        unwrap_private_bundle(wrapped, params, "wrong-password")


def test_private_bundle_uses_real_kdf_with_random_salt():
    """Guards against regressing to the tests.py `password.ljust(32,'X')` construction."""
    b = generate_identity(USER_A, DEVICE_A)
    w1, p1 = wrap_private_bundle(b, "same-password")
    w2, p2 = wrap_private_bundle(b, "same-password")

    assert p1["kdf"] == "argon2id"
    assert p1["m"] >= 65536 and p1["t"] >= 3
    # Same password, same keys -> different ciphertext, because salt and nonce are random.
    assert p1["salt"] != p2["salt"]
    assert w1 != w2


def test_private_bundle_detects_tampering():
    b = generate_identity(USER_A, DEVICE_A)
    wrapped, params = wrap_private_bundle(b, "pw")

    raw = bytearray(b64u_decode(wrapped))
    raw[0] ^= 0x01

    with pytest.raises(Exception):
        unwrap_private_bundle(b64u_encode(bytes(raw)), params, "pw")


def test_safety_number_is_symmetric_and_stable():
    a = generate_identity(USER_A, DEVICE_A)
    b = generate_identity(USER_B, DEVICE_B)

    ab = safety_number(a.signing_public, b.signing_public)
    ba = safety_number(b.signing_public, a.signing_public)

    assert ab == ba, "both peers must compute the same fingerprint"
    assert ab == safety_number(a.signing_public, b.signing_public)

    groups = ab.split(" ")
    assert len(groups) == 12
    assert all(len(g) == 5 and g.isdigit() for g in groups)


def test_safety_number_groups_all_carry_entropy():
    """Regression: the digest must be long enough to fill all 12 groups.

    SHA-256 yields 32 bytes but 12 groups consume 48, and Python slices past the end silently, so
    the last four groups were always "00000" — displaying 60 digits while carrying 40 digits of
    entropy. Caught by the TypeScript client, where DataView raises instead of returning empty.
    """
    seen_per_position = [set() for _ in range(12)]

    for i in range(24):
        a = generate_identity(USER_A, DEVICE_A)
        b = generate_identity(USER_B, DEVICE_B)
        for position, group in enumerate(safety_number(a.signing_public, b.signing_public).split(" ")):
            seen_per_position[position].add(group)

    for position, values in enumerate(seen_per_position):
        assert len(values) > 1, f"group {position + 1} is constant across samples: {values}"


def test_safety_number_changes_when_a_key_changes():
    """This is what makes a malicious key substitution visible to users."""
    a = generate_identity(USER_A, DEVICE_A)
    b = generate_identity(USER_B, DEVICE_B)
    impostor = generate_identity(USER_B, DEVICE_B)

    assert safety_number(a.signing_public, b.signing_public) != \
           safety_number(a.signing_public, impostor.signing_public)
