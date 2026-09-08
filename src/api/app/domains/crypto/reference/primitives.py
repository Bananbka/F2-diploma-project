"""Shared encoding and domain-separation primitives for wire format v1.

Every multi-byte value that goes into a signature or AEAD associated-data blob is encoded here,
in one place, so the backend and any client cannot drift. Getting these encodings wrong is the
classic source of "it verifies locally but not against the other implementation" bugs.
"""
import base64
import uuid

# Domain separators. Every signed or AEAD-bound blob starts with one of these so a value produced
# for one purpose can never be replayed as a value for another (cross-protocol confusion).
DS_IDENTITY_BIND = b"NS-v1-idbind"
DS_PREKEY_BIND = b"NS-v1-prekeybind"  # signed prekey bound to its user and device
DS_MESSAGE = b"NS-v1-msg"          # AAD prefix for a sealed message
DS_MESSAGE_KEY = b"NS-v1-msgkey"   # HKDF info when deriving a message key from a chain key
DS_CHAIN = b"NS-v1-chain"          # HKDF info when advancing the chain
DS_GRANT = b"NS-v1-grant"          # AAD for a wrapped sender key
DS_SENDER_KEY = b"NS-v1-skdm"      # sender key distribution signature
DS_MEMBER_SET = b"NS-v1-memberset"  # epoch membership hash
DS_CHANNEL_POST = b"NS-v1-post"    # signed (but not encrypted) channel post
DS_FINGERPRINT = b"NS-v1-fingerprint"

VERSION = 1


def b64u_encode(raw: bytes) -> str:
    """base64url without padding. Padding is stripped so values are URL- and JSON-clean."""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64u_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def u32be(value: int) -> bytes:
    """4-byte big-endian. Used for every integer in AAD and signature inputs."""
    if not 0 <= value <= 0xFFFFFFFF:
        raise ValueError(f"value out of range for u32: {value}")
    return value.to_bytes(4, "big")


def uuid_bytes(value: uuid.UUID | str) -> bytes:
    """UUIDs are bound as their 16 raw bytes, never as a hyphenated string."""
    if isinstance(value, str):
        value = uuid.UUID(value)
    return value.bytes
