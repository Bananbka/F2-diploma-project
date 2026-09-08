"""Message envelope: seal, open, and verify.

The envelope is what replaces the bare `encrypted_content` string. Its security rests on the
associated-data binding below — without it a ciphertext is a free-floating blob the server can move
between chats, epochs or senders.

    msg_aad = "NS-v1-msg" || chat_id(16) || u32be(epoch) || sender_id(16)
                          || sender_key_id(16) || u32be(chain_index)     = 65 bytes

    ct  = AES-256-GCM(key=MK_i, nonce=N_i, plaintext=body, aad=msg_aad)
    sig = Ed25519(chain_signing_key, msg_aad || SHA256(ct))

Each bound field blocks a specific attack:

    chat_id         copying a ciphertext into another chat the attacker also belongs to
    epoch           replaying a pre-removal message into the post-removal epoch
    sender_id       the server relabelling sender_id in Mongo to misattribute a message
    sender_key_id   confusion when one sender has two chains in an epoch (multi-device)
    chain_index     reordering or index-shifting; also what makes the derived nonce unique

**The AAD must be rebuilt from trusted values, never read back out of the envelope.** `chat_id`
comes from the URL path after `get_chat_or_403` and `sender_id` from the JWT. If those were taken
from the envelope, a client could set them freely and the binding would prove nothing. That is why
`seal_message` and `open_message` take them as explicit arguments.

Signing SHA256(ct) rather than ct keeps signature cost flat for large attachments.
"""
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256, Hash

from app.domains.crypto.reference.primitives import (
    DS_MESSAGE,
    VERSION,
    b64u_decode,
    b64u_encode,
    u32be,
    uuid_bytes,
)

ALGORITHM = "A256GCM-SK1"


def build_message_aad(chat_id, epoch: int, sender_id, sender_key_id, chain_index: int) -> bytes:
    return (
        DS_MESSAGE
        + uuid_bytes(chat_id)
        + u32be(epoch)
        + uuid_bytes(sender_id)
        + uuid_bytes(sender_key_id)
        + u32be(chain_index)
    )


def _signature_payload(aad: bytes, ciphertext: bytes) -> bytes:
    digest = Hash(SHA256())
    digest.update(ciphertext)
    return aad + digest.finalize()


def seal_message(
        *,
        message_key: bytes,
        nonce: bytes,
        signing_private: bytes,
        chat_id,
        epoch: int,
        sender_id,
        sender_key_id,
        chain_index: int,
        plaintext: bytes,
) -> dict:
    """Encrypt and sign one message. Returns the envelope dict stored in Mongo."""
    aad = build_message_aad(chat_id, epoch, sender_id, sender_key_id, chain_index)
    ciphertext = AESGCM(message_key).encrypt(nonce, plaintext, aad)

    signature = Ed25519PrivateKey.from_private_bytes(signing_private).sign(
        _signature_payload(aad, ciphertext)
    )

    return {
        "v": VERSION,
        "alg": ALGORITHM,
        "epoch": epoch,
        "skid": str(sender_key_id),
        "idx": chain_index,
        "n": b64u_encode(nonce),
        "ct": b64u_encode(ciphertext),
        "sig": b64u_encode(signature),
    }


def verify_envelope_signature(
        *,
        envelope: dict,
        signing_public: bytes,
        chat_id,
        sender_id,
) -> bool:
    """Check the sender signature. Runs server-side on send (~50 µs).

    The server cannot read the message, but it can prove the sender is who the envelope claims —
    the only integrity check available to it, and enough to stop forged-attribution injection.
    """
    try:
        aad = build_message_aad(
            chat_id, envelope["epoch"], sender_id, envelope["skid"], envelope["idx"]
        )
        Ed25519PublicKey.from_public_bytes(signing_public).verify(
            b64u_decode(envelope["sig"]),
            _signature_payload(aad, b64u_decode(envelope["ct"])),
        )
        return True
    except (InvalidSignature, KeyError, ValueError, TypeError):
        return False


def open_message(
        *,
        message_key: bytes,
        envelope: dict,
        chat_id,
        sender_id,
        signing_public: bytes | None = None,
) -> bytes:
    """Verify and decrypt. chat_id/sender_id are the trusted values, not the envelope's.

    Signature verification happens before decryption when a key is supplied: a client should never
    act on a message whose sender it has not authenticated.
    """
    if signing_public is not None and not verify_envelope_signature(
            envelope=envelope, signing_public=signing_public,
            chat_id=chat_id, sender_id=sender_id,
    ):
        raise InvalidSignature("envelope signature does not verify")

    aad = build_message_aad(
        chat_id, envelope["epoch"], sender_id, envelope["skid"], envelope["idx"]
    )

    # A mismatch in any bound field surfaces here as a GCM tag failure.
    return AESGCM(message_key).decrypt(
        b64u_decode(envelope["n"]), b64u_decode(envelope["ct"]), aad
    )
