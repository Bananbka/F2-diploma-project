"""Known-answer and property tests for the v1 identity layer.

These pin the wire format. If a change here breaks a test, that is a protocol change and every
client must be updated in lockstep — it is not a test to "fix".
"""
import uuid
from dataclasses import replace

import pytest

from app.domains.crypto.reference.identity import (
    generate_identity,
    safety_number,
    unwrap_private_bundle,
    verify_identity_binding,
    verify_signed_prekey,
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


def test_generate_identity_includes_a_signed_prekey_by_default():
    """A real client mints the prekey at registration, alongside the identity keypair, so its
    private half is in the sealed bundle from the start — see crypto-spec-v1.md §2.2."""
    b = generate_identity(USER_A, DEVICE_A)

    assert b.prekey_private is not None
    assert len(b.prekey_private) == 32
    assert len(b.prekey_public) == 32
    assert len(b.signed_prekey_signature) == 64
    assert verify_signed_prekey(
        USER_A, DEVICE_A, b.prekey_public, b.signing_public, b.signed_prekey_signature
    )


def test_generate_identity_without_prekey_models_a_pre_fix_bundle():
    """`with_prekey=False` is how these tests model a bundle sealed before rotation existed."""
    b = generate_identity(USER_A, DEVICE_A, with_prekey=False)

    assert b.prekey_private is None
    assert b.prekey_public is None
    assert b.signed_prekey_signature is None


def test_private_bundle_round_trip_includes_prekey_private():
    """The fix in one assertion: the sealed bundle now carries the prekey's private half, so it
    survives being written to storage and read back — which is the entire point of the change."""
    b = generate_identity(USER_A, DEVICE_A)
    wrapped, params = wrap_private_bundle(b, "correct horse battery staple")

    out = unwrap_private_bundle(wrapped, params, "correct horse battery staple")

    assert out["prekey_private"] == b.prekey_private


def test_private_bundle_without_a_prekey_omits_the_field_rather_than_erroring():
    """Backward compatibility: a bundle sealed with no prekey (modelling one sealed before this
    fix existed) must unwrap cleanly, simply without a `prekey_private` entry — never a KeyError.
    There is nothing for the server to migrate, since it never opens the blob; the next re-seal
    (a rotation, or a change-password re-wrap) is what adds the field."""
    b = generate_identity(USER_A, DEVICE_A, with_prekey=False)
    wrapped, params = wrap_private_bundle(b, "pw")

    out = unwrap_private_bundle(wrapped, params, "pw")

    assert "prekey_private" not in out
    assert out["signing_private"] == b.signing_private
    assert out["identity_private"] == b.identity_private


def test_private_bundle_round_trip_includes_prev_prekey_private_during_the_grace_window():
    """After a rotation, the client carries the outgoing prekey's private half forward as
    `prev_prekey_private` for exactly one further cycle, so a grant wrapped to it just before
    rotation but not yet ingested can still be opened. That extra field must round-trip too."""
    b = generate_identity(USER_A, DEVICE_A)
    rotated = replace(b, prev_prekey_private=b.prekey_private)
    wrapped, params = wrap_private_bundle(rotated, "correct horse battery staple")

    out = unwrap_private_bundle(wrapped, params, "correct horse battery staple")

    assert out["prekey_private"] == rotated.prekey_private
    assert out["prev_prekey_private"] == b.prekey_private


def test_private_bundle_without_a_rotation_yet_omits_prev_prekey_private():
    """Right after registration (or before a device's first rotation) there is no previous
    generation to retain, so `prev_prekey_private` must be absent, never present-but-null."""
    b = generate_identity(USER_A, DEVICE_A)
    wrapped, params = wrap_private_bundle(b, "pw")

    out = unwrap_private_bundle(wrapped, params, "pw")

    assert "prev_prekey_private" not in out
    assert out["prekey_private"] == b.prekey_private


def test_second_rotation_discards_the_older_generation_rather_than_accumulating():
    """`prev_prekey_private` is a one-cycle grace window, not a history. Modelling two rotations in
    a row: the bundle re-sealed after the second rotation must carry only the *first* rotation's
    outgoing prekey as `prev_prekey_private` — the original registration prekey is gone."""
    registered = generate_identity(USER_A, DEVICE_A)

    first_rotation = replace(
        registered,
        prekey_private=b"1" * 32,
        prekey_public=b"1" * 32,
        prev_prekey_private=None,  # nothing to retain yet at the first rotation
    )
    second_rotation = replace(
        first_rotation,
        prekey_private=b"2" * 32,
        prekey_public=b"2" * 32,
        prev_prekey_private=registered.prekey_private,  # the generation first_rotation superseded
    )

    wrapped, params = wrap_private_bundle(second_rotation, "pw")
    out = unwrap_private_bundle(wrapped, params, "pw")

    assert out["prekey_private"] == b"2" * 32
    assert out["prev_prekey_private"] == registered.prekey_private
    assert out["prev_prekey_private"] != first_rotation.prekey_private


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
