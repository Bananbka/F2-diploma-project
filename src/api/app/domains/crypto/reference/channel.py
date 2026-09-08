"""Channel posts: signed, not encrypted.

Channels sit deliberately outside the end-to-end trust boundary, for two reasons that are worth
stating rather than hiding:

1. **Confidentiality is meaningless for open broadcast.** A channel anyone can subscribe to gives
   its content to any adversary who subscribes. No amount of cryptography changes that.
2. **Sender-key distribution does not survive the scale.** Grants cost O(N) per rotation, executed
   on one client, and every unsubscribe forces a rotation. At a few thousand subscribers with
   normal churn a client can never finish wrapping before the next epoch opens.

**Integrity, however, is not meaningless.** A subscriber genuinely wants to know a post came from
the channel owner and was not fabricated or altered by the server. That costs one signature per
post, O(1) regardless of subscriber count, with no key distribution at all.

This is essentially what deployed messengers do: Telegram channels and WhatsApp Channels are both
server-readable. The honest position is to say so and secure what can actually be secured.
"""
from hashlib import sha256

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from app.domains.crypto.reference.primitives import (
    DS_CHANNEL_POST,
    b64u_decode,
    b64u_encode,
    uuid_bytes,
)

ALGORITHM = "ed25519-post-v1"


def channel_post_payload(chat_id, sender_id, post_id, content: str) -> bytes:
    """What a channel post signature covers.

    chat_id and sender_id stop a signed post being relocated to another channel or reattributed.
    post_id makes each signature unique, so an identical post cannot be duplicated by replaying a
    captured (content, signature) pair.
    """
    return (
        DS_CHANNEL_POST
        + uuid_bytes(chat_id)
        + uuid_bytes(sender_id)
        + uuid_bytes(post_id)
        + sha256(content.encode("utf-8")).digest()
    )


def sign_channel_post(*, signing_private: bytes, chat_id, sender_id, post_id, content: str) -> str:
    signature = Ed25519PrivateKey.from_private_bytes(signing_private).sign(
        channel_post_payload(chat_id, sender_id, post_id, content)
    )
    return b64u_encode(signature)


def verify_channel_post(
        *, signing_public: bytes, signature: str, chat_id, sender_id, post_id, content: str
) -> bool:
    """Verified by the server on publish and by every subscriber on read.

    Server-side verification is worth doing even though the server could simply refuse to store the
    post: it means a stored post is always one the claimed author actually signed.
    """
    try:
        Ed25519PublicKey.from_public_bytes(signing_public).verify(
            b64u_decode(signature),
            channel_post_payload(chat_id, sender_id, post_id, content),
        )
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False
