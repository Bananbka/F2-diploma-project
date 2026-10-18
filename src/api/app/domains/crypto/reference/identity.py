"""Identity keys: X25519 for key agreement, Ed25519 for signatures.

Each device holds two keypairs:

  * Ed25519 ("signing key")  — signs messages and sender-key distributions. This is the key a
    peer verifies out-of-band via a safety number, so it is the root of authenticity.
  * X25519  ("identity key") — receives wrapped sender keys via ECDH.

They are separate rather than one key reused for both algorithms: reusing a single key across a
signature scheme and a DH scheme is a known cross-protocol footgun. The X25519 public key is
*signed* by the Ed25519 key so a verifier can confirm the two belong to the same identity.

The private halves are wrapped client-side under a key derived from the user's password with
Argon2id. This matters more than usual here: the wrapped bundle is stored on the server, so it is
an offline password-guessing target if the database is ever disclosed. The parameters below are
therefore a security control, not hygiene.

Contrast with the old `tests.py` scratch script, which used `password.ljust(32, 'X')` as its
"KDF" — that is not key derivation at all and produced keys recoverable in milliseconds.
"""

import json
import os
from dataclasses import dataclass

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA512, Hash

from app.domains.crypto.reference.primitives import (
    DS_FINGERPRINT,
    DS_IDENTITY_BIND,
    DS_PREKEY_BIND,
    b64u_decode,
    b64u_encode,
    uuid_bytes,
)

ALGORITHM = "x25519_ed25519_v1"

# OWASP-aligned Argon2id parameters: 64 MiB, 3 iterations, 4 lanes.
ARGON2_MEMORY_KIB = 65536
ARGON2_TIME_COST = 3
ARGON2_PARALLELISM = 4
ARGON2_SALT_BYTES = 16
KEK_BYTES = 32
GCM_NONCE_BYTES = 12


@dataclass(frozen=True)
class IdentityBundle:
    """A device's full keypair set. The private fields never leave the client in production.

    `prekey_*` are optional because a bundle unwrapped from storage sealed before prekey rotation
    was re-enabled has no prekey at all (backward compat — see `unwrap_private_bundle`), and
    because a caller who only wants an identity/signing pair (e.g. minting a throwaway chain
    identity to sign a sender-key distribution) has no use for one either.
    """

    signing_private: bytes
    signing_public: bytes
    identity_private: bytes
    identity_public: bytes
    identity_key_signature: bytes
    # Medium-term X25519 prekey. Generated alongside the identity keypair from registration
    # onward so its private half is already inside the sealed bundle by the time a rotation
    # would need somewhere to put a new one — see module docstring and crypto-spec-v1.md §2.1.1.
    prekey_private: bytes | None = None
    prekey_public: bytes | None = None
    signed_prekey_signature: bytes | None = None
    # The *previous* generation's prekey private half, retained for exactly one rotation cycle.
    # A grant published against the old signed prekey but not yet ingested by this device at the
    # moment of rotation would otherwise become permanently unopenable — the recipient's private
    # half was already gone by the time it tried to unwrap. This is a one-cycle grace window, not
    # unlimited retention: a *second* rotation discards whatever was here and replaces it with the
    # prekey generation that is itself being superseded. See crypto-spec-v1.md §2.1.2 and §2.2.
    prev_prekey_private: bytes | None = None


def _raw_public(key: Ed25519PublicKey | X25519PublicKey) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def _raw_private(key: Ed25519PrivateKey | X25519PrivateKey) -> bytes:
    return key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )


def identity_binding_message(user_id, device_id, identity_public: bytes) -> bytes:
    """The blob the Ed25519 key signs to vouch for its X25519 counterpart.

    Binding user_id and device_id in stops a valid (identity_public, signature) pair being
    transplanted onto a different user or device.
    """
    return (
        DS_IDENTITY_BIND + uuid_bytes(user_id) + uuid_bytes(device_id) + identity_public
    )


def generate_identity(user_id, device_id, *, with_prekey: bool = True) -> IdentityBundle:
    """Generate a device's full keypair set.

    `with_prekey=True` by default: a real client mints the signed prekey at registration time,
    alongside the identity keypair, precisely so its private half is available immediately after
    unlock with no extra password prompt. Pass `with_prekey=False` to model a bundle sealed before
    prekey rotation was re-enabled (see `unwrap_private_bundle`'s backward-compat note) or to build
    a throwaway identity that has no business publishing a prekey at all.
    """
    signing_private = Ed25519PrivateKey.generate()
    identity_private = X25519PrivateKey.generate()

    signing_public = _raw_public(signing_private.public_key())
    identity_public = _raw_public(identity_private.public_key())

    signature = signing_private.sign(
        identity_binding_message(user_id, device_id, identity_public)
    )

    prekey_private = prekey_public = prekey_signature = None
    if with_prekey:
        prekey_keypair = X25519PrivateKey.generate()
        prekey_public = _raw_public(prekey_keypair.public_key())
        prekey_private = _raw_private(prekey_keypair)
        prekey_signature = signing_private.sign(
            prekey_binding_message(user_id, device_id, prekey_public)
        )

    return IdentityBundle(
        signing_private=_raw_private(signing_private),
        signing_public=signing_public,
        identity_private=_raw_private(identity_private),
        identity_public=identity_public,
        identity_key_signature=signature,
        prekey_private=prekey_private,
        prekey_public=prekey_public,
        signed_prekey_signature=prekey_signature,
    )


def verify_identity_binding(
    user_id,
    device_id,
    identity_public: bytes,
    signing_public: bytes,
    signature: bytes,
) -> bool:
    """Check that signing_public vouches for identity_public. Cheap enough to run server-side."""
    try:
        Ed25519PublicKey.from_public_bytes(signing_public).verify(
            signature, identity_binding_message(user_id, device_id, identity_public)
        )
        return True
    except Exception:
        return False


def prekey_binding_message(user_id, device_id, signed_prekey_public: bytes) -> bytes:
    """The blob the Ed25519 key signs to vouch for a medium-term signed prekey.

    Its own domain separator, not DS_IDENTITY_BIND: both sign a 32-byte X25519 public key for the
    same (user, device), so sharing a separator would let a prekey signature be replayed as an
    identity-key binding and vice versa. User and device are bound in for the same reason they are
    in the identity binding — a valid (key, signature) pair must not transplant onto another device.
    """
    return (
        DS_PREKEY_BIND
        + uuid_bytes(user_id)
        + uuid_bytes(device_id)
        + signed_prekey_public
    )


def verify_signed_prekey(
    user_id,
    device_id,
    signed_prekey_public: bytes,
    signing_public: bytes,
    signature: bytes,
) -> bool:
    """Check that the device's identity signing key vouches for this prekey.

    Grants prefer the signed prekey over the identity key as the ECDH recipient, so an unverified
    prekey would let anyone who can write to the roster substitute a key they hold — exactly the
    substitution the signature exists to prevent.
    """
    try:
        Ed25519PublicKey.from_public_bytes(signing_public).verify(
            signature, prekey_binding_message(user_id, device_id, signed_prekey_public)
        )
        return True
    except Exception:
        return False


def derive_kek(password: str, salt: bytes) -> bytes:
    """Argon2id password -> 32-byte key-encryption-key."""
    return hash_secret_raw(
        secret=password.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_KIB,
        parallelism=ARGON2_PARALLELISM,
        hash_len=KEK_BYTES,
        type=Type.ID,
    )


def wrap_private_bundle(bundle: IdentityBundle, password: str) -> tuple[str, dict]:
    """Encrypt the private halves under Argon2id(password). Returns (b64u blob, kdf_params).

    kdf_params is stored alongside so the client can reproduce the KEK, and so parameters can be
    raised later without invalidating existing blobs.
    """
    salt = os.urandom(ARGON2_SALT_BYTES)
    nonce = os.urandom(GCM_NONCE_BYTES)
    kek = derive_kek(password, salt)

    payload = {
        "signing_private": b64u_encode(bundle.signing_private),
        "identity_private": b64u_encode(bundle.identity_private),
    }
    # Absent, not null, when there is no prekey — so a bundle sealed before rotation existed and
    # one sealed by a client that chose not to publish a prekey are indistinguishable from a
    # bundle that genuinely has nothing to unwrap here, and `unwrap_private_bundle` treats a
    # missing key as "no prekey" rather than as a value to fail on.
    if bundle.prekey_private is not None:
        payload["prekey_private"] = b64u_encode(bundle.prekey_private)
    # Same convention: absent, not null, when there is no retained previous generation — which is
    # every bundle before a device's first rotation, and any bundle re-sealed after two rotations
    # have already elapsed without the grace-window key being carried forward.
    if bundle.prev_prekey_private is not None:
        payload["prev_prekey_private"] = b64u_encode(bundle.prev_prekey_private)

    plaintext = json.dumps(payload).encode("utf-8")

    ciphertext = AESGCM(kek).encrypt(nonce, plaintext, None)

    kdf_params = {
        "kdf": "argon2id",
        "m": ARGON2_MEMORY_KIB,
        "t": ARGON2_TIME_COST,
        "p": ARGON2_PARALLELISM,
        "salt": b64u_encode(salt),
        "nonce": b64u_encode(nonce),
    }
    return b64u_encode(ciphertext), kdf_params


def unwrap_private_bundle(
    wrapped: str, kdf_params: dict, password: str
) -> dict[str, bytes]:
    """Inverse of wrap_private_bundle. Raises on a wrong password (GCM tag failure).

    `prekey_private` and `prev_prekey_private` are only present in the returned dict when the
    sealed plaintext carried them. A bundle sealed before prekey rotation was re-enabled has
    neither field — that is the entire backward-compat story here, since the server never opens
    the blob and so has nothing to migrate: the next re-seal (rotation, or a change-password
    re-wrap) is what adds `prekey_private`, and a second rotation after that is what adds
    `prev_prekey_private`.
    """
    kek = hash_secret_raw(
        secret=password.encode("utf-8"),
        salt=b64u_decode(kdf_params["salt"]),
        time_cost=kdf_params["t"],
        memory_cost=kdf_params["m"],
        parallelism=kdf_params["p"],
        hash_len=KEK_BYTES,
        type=Type.ID,
    )

    plaintext = AESGCM(kek).decrypt(
        b64u_decode(kdf_params["nonce"]), b64u_decode(wrapped), None
    )
    payload = json.loads(plaintext)

    out = {
        "signing_private": b64u_decode(payload["signing_private"]),
        "identity_private": b64u_decode(payload["identity_private"]),
    }
    if "prekey_private" in payload:
        out["prekey_private"] = b64u_decode(payload["prekey_private"])
    if "prev_prekey_private" in payload:
        out["prev_prekey_private"] = b64u_decode(payload["prev_prekey_private"])

    return out


def user_fingerprint_material(signing_publics) -> bytes:
    """Collapse all of a user's active device signing keys into one 32-byte value.

    A safety number is a property of a *person*, but keys belong to devices. Feeding it one
    arbitrarily chosen device key — which is what a bare `.limit(1)` produced — meant the two
    peers could compute different numbers depending on row order, and that adding a device
    silently left the old number valid. Both are wrong: the number must cover everything the peer
    would accept, and it must change when that set changes.

    Sorted, so ordering of the input cannot change the result.
    """
    digest = Hash(SHA512())
    digest.update(DS_FINGERPRINT)

    for key in sorted(signing_publics):
        digest.update(len(key).to_bytes(2, "big"))
        digest.update(key)

    return digest.finalize()[:32]


def safety_number(signing_public_a: bytes, signing_public_b: bytes) -> str:
    """A stable 60-digit fingerprint two users compare out-of-band.

    Inputs are sorted so both sides compute the same value regardless of who is 'A'. This is the
    only defence against a malicious server substituting a public key, so it must be surfaced in
    the UI and must visibly change when a peer's key changes.

    SHA-512 rather than SHA-256 because 12 groups consume 48 bytes: a 32-byte digest cannot fill
    them, and Python would silently yield empty slices for the tail, producing four groups of
    "00000" on every fingerprint. That would display 60 digits while carrying only 40 digits of
    entropy — overstating the verification strength users are relying on.
    """
    first, second = sorted([signing_public_a, signing_public_b])

    digest = Hash(SHA512())
    digest.update(DS_FINGERPRINT + first + second)
    raw = digest.finalize()

    # 12 groups of 5 digits, derived from successive 4-byte words.
    groups = [
        f"{int.from_bytes(raw[i : i + 4], 'big') % 100000:05d}" for i in range(0, 48, 4)
    ]
    return " ".join(groups)
