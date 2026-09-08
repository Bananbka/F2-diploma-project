"""Sender key distribution: wrapping a chain key to each recipient device.

A sender that wants to write into an epoch generates a chain key, then wraps it once per recipient
device using ephemeral X25519 ECDH against that device's public key. The server stores the wrapped
blobs and can open none of them.

Two things here carry most of the security weight:

**The distribution signature.** A grant on its own says nothing about who produced it. The sender
signs (chat, epoch, sender_key_id, chain signing key, start index) with its long-term Ed25519
identity, so a recipient can tell a real distribution from one the server fabricated.

**The member set hash.** An epoch commits to the exact set of devices it was created for. Before
wrapping, a client recomputes the hash from the roster the server returned and refuses on mismatch.
Without that check a malicious server silently adds a ghost device and every sender dutifully wraps
the chain key for it — the cryptography behaving perfectly while confidentiality is lost, because
membership is server-authoritative while confidentiality is client-enforced. The backend cannot
enforce this; it only stores the value so clients can compare.
"""
import os
from hashlib import sha256

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.domains.crypto.reference.primitives import (
    DS_GRANT,
    DS_MEMBER_SET,
    DS_SENDER_KEY,
    b64u_decode,
    b64u_encode,
    u32be,
    uuid_bytes,
)

WRAP_ALGORITHM = "x25519_hkdf_sha256_aes256gcm_v1"
SENDER_KEY_ALGORITHM = "hkdf_sha256_aes256gcm_v1"

NONCE_BYTES = 12
WRAP_KEY_BYTES = 32


def compute_member_set_hash(device_ids) -> str:
    """Commit to an epoch's exact device set.

    Sorted so every participant derives the same value regardless of roster ordering.
    """
    joined = "|".join(sorted(str(d) for d in device_ids)).encode("utf-8")
    return sha256(DS_MEMBER_SET + joined).hexdigest()


def distribution_signing_payload(
        chat_id, epoch: int, sender_key_id, signing_public: bytes, chain_start_index: int
) -> bytes:
    return (
        DS_SENDER_KEY
        + uuid_bytes(chat_id)
        + u32be(epoch)
        + uuid_bytes(sender_key_id)
        + signing_public
        + u32be(chain_start_index)
    )


def sign_distribution(
        *, identity_signing_private: bytes, chat_id, epoch: int, sender_key_id,
        chain_signing_public: bytes, chain_start_index: int,
) -> bytes:
    """Vouch for a chain's signing key with the sender's long-term identity key."""
    return Ed25519PrivateKey.from_private_bytes(identity_signing_private).sign(
        distribution_signing_payload(
            chat_id, epoch, sender_key_id, chain_signing_public, chain_start_index
        )
    )


def verify_distribution(
        *, identity_signing_public: bytes, signature: bytes, chat_id, epoch: int, sender_key_id,
        chain_signing_public: bytes, chain_start_index: int,
) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(identity_signing_public).verify(
            signature,
            distribution_signing_payload(
                chat_id, epoch, sender_key_id, chain_signing_public, chain_start_index
            ),
        )
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def build_grant_aad(
        *, chat_id, epoch: int, sender_key_id, sender_device_id, recipient_device_id,
        ephemeral_public: bytes,
) -> bytes:
    """Bind a wrapped key to exactly one (chat, epoch, sender, recipient, ephemeral) tuple.

    Including the ephemeral public key in the AAD *and* the HKDF info blocks reuse of a captured
    ephemeral against a different recipient.
    """
    return (
        DS_GRANT
        + uuid_bytes(chat_id)
        + u32be(epoch)
        + uuid_bytes(sender_key_id)
        + uuid_bytes(sender_device_id)
        + uuid_bytes(recipient_device_id)
        + ephemeral_public
    )


def _derive_wrap_key(shared_secret: bytes, chat_id, epoch: int, aad: bytes) -> tuple[bytes, bytes]:
    okm = HKDF(
        algorithm=SHA256(),
        length=WRAP_KEY_BYTES + NONCE_BYTES,
        salt=sha256(uuid_bytes(chat_id) + u32be(epoch)).digest(),
        info=aad,
    ).derive(shared_secret)

    return okm[:WRAP_KEY_BYTES], okm[WRAP_KEY_BYTES:]


def wrap_chain_key(
        *, chain_key: bytes, chain_start_index: int, recipient_public: bytes,
        chat_id, epoch: int, sender_key_id, sender_device_id, recipient_device_id,
) -> tuple[str, str]:
    """Wrap a chain key for one recipient device. Returns (ephemeral_public, wrapped) as b64u.

    `recipient_public` should be the recipient's signed prekey when available — that gives forward
    secrecy for the grant once the prekey rotates — falling back to their long-term identity key.
    """
    ephemeral_private = X25519PrivateKey.generate()
    ephemeral_public = ephemeral_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )

    shared_secret = ephemeral_private.exchange(
        X25519PublicKey.from_public_bytes(recipient_public)
    )

    aad = build_grant_aad(
        chat_id=chat_id, epoch=epoch, sender_key_id=sender_key_id,
        sender_device_id=sender_device_id, recipient_device_id=recipient_device_id,
        ephemeral_public=ephemeral_public,
    )
    wrap_key, nonce = _derive_wrap_key(shared_secret, chat_id, epoch, aad)

    ciphertext = AESGCM(wrap_key).encrypt(
        nonce, chain_key + u32be(chain_start_index), aad
    )

    return b64u_encode(ephemeral_public), b64u_encode(nonce + ciphertext)


def unwrap_chain_key(
        *, wrapped: str, ephemeral_public: str, recipient_private: bytes,
        chat_id, epoch: int, sender_key_id, sender_device_id, recipient_device_id,
) -> tuple[bytes, int]:
    """Inverse of wrap_chain_key. Returns (chain_key, chain_start_index).

    Any mismatch in the bound fields surfaces as a GCM tag failure rather than a wrong-but-usable
    key, so a relocated grant fails closed.
    """
    ephemeral_raw = b64u_decode(ephemeral_public)
    blob = b64u_decode(wrapped)
    nonce, ciphertext = blob[:NONCE_BYTES], blob[NONCE_BYTES:]

    shared_secret = X25519PrivateKey.from_private_bytes(recipient_private).exchange(
        X25519PublicKey.from_public_bytes(ephemeral_raw)
    )

    aad = build_grant_aad(
        chat_id=chat_id, epoch=epoch, sender_key_id=sender_key_id,
        sender_device_id=sender_device_id, recipient_device_id=recipient_device_id,
        ephemeral_public=ephemeral_raw,
    )
    wrap_key, _ = _derive_wrap_key(shared_secret, chat_id, epoch, aad)

    plaintext = AESGCM(wrap_key).decrypt(nonce, ciphertext, aad)

    return plaintext[:32], int.from_bytes(plaintext[32:36], "big")
