"""Symmetric sender-key ratchet.

Each sender owns one chain per (chat, epoch). The chain key advances one step per message and the
previous value is discarded, so a device compromised at index N cannot recover messages sent at
indices below N. That is the forward secrecy a single shared epoch key cannot provide: a shared key
has N concurrent writers with out-of-order delivery and therefore nothing to ratchet.

    CK_0        random 32 bytes
    MK_i, N_i = HKDF(CK_i, info="NS-v1-msgkey", L=44)   -> 32-byte AES key + 12-byte nonce
    CK_{i+1}  = HKDF(CK_i, info="NS-v1-chain",  L=32)

The nonce is *derived*, not random. Since MK_i is already unique per index, a derived nonce makes
catastrophic GCM nonce reuse structurally impossible rather than merely improbable — you cannot
accidentally repeat a (key, nonce) pair by mishandling a random source.

The chain is one-way, which is what makes ratchet-forward grants possible: handing a peer CK_i
grants them messages i onward and nothing earlier.
"""
import os

from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.domains.crypto.reference.primitives import DS_CHAIN, DS_MESSAGE_KEY

CHAIN_KEY_BYTES = 32
MESSAGE_KEY_BYTES = 32
NONCE_BYTES = 12

# How far ahead we will derive keys to service an out-of-order message. Unbounded derivation is a
# denial-of-service vector: a peer could claim index 2**31 and force that many HKDF rounds.
MAX_SKIP = 2000


def generate_chain_key() -> bytes:
    return os.urandom(CHAIN_KEY_BYTES)


def derive_message_key(chain_key: bytes) -> tuple[bytes, bytes]:
    """Chain key -> (message key, nonce) for the message at this index."""
    okm = HKDF(
        algorithm=SHA256(),
        length=MESSAGE_KEY_BYTES + NONCE_BYTES,
        salt=None,
        info=DS_MESSAGE_KEY,
    ).derive(chain_key)

    return okm[:MESSAGE_KEY_BYTES], okm[MESSAGE_KEY_BYTES:]


def advance_chain(chain_key: bytes) -> bytes:
    """Ratchet one step forward. The caller must discard the old chain key."""
    return HKDF(
        algorithm=SHA256(),
        length=CHAIN_KEY_BYTES,
        salt=None,
        info=DS_CHAIN,
    ).derive(chain_key)


class SenderChain:
    """Sending side. Owns a chain key and hands out one message key per call."""

    def __init__(self, chain_key: bytes, index: int = 0):
        self._chain_key = chain_key
        self.index = index

    def next_message_key(self) -> tuple[bytes, bytes, int]:
        message_key, nonce = derive_message_key(self._chain_key)
        used_index = self.index

        # Ratchet immediately and drop the previous chain key: after this returns, the key that
        # produced `message_key` no longer exists in memory.
        self._chain_key = advance_chain(self._chain_key)
        self.index += 1

        return message_key, nonce, used_index


class ReceiverChain:
    """Receiving side, tolerant of out-of-order and dropped messages.

    Keys for indices we skipped past are cached so a late-arriving message still opens, bounded by
    MAX_SKIP. A real client must persist `skipped` alongside the chain state, and should expire it
    — retained message keys are exactly the material that undermines forward secrecy if kept
    forever.
    """

    def __init__(self, chain_key: bytes, index: int = 0):
        self._chain_key = chain_key
        self.index = index
        self.skipped: dict[int, tuple[bytes, bytes]] = {}

    def message_key_for(self, target_index: int) -> tuple[bytes, bytes]:
        if target_index in self.skipped:
            return self.skipped.pop(target_index)

        if target_index < self.index:
            raise ValueError(
                f"message key for index {target_index} is already consumed and was not retained"
            )

        if target_index - self.index > MAX_SKIP:
            raise ValueError(
                f"refusing to skip {target_index - self.index} messages (limit {MAX_SKIP})"
            )

        # Walk forward, retaining the keys we step over so those messages can still arrive later.
        while self.index < target_index:
            self.skipped[self.index] = derive_message_key(self._chain_key)
            self._chain_key = advance_chain(self._chain_key)
            self.index += 1

        message_key, nonce = derive_message_key(self._chain_key)
        self._chain_key = advance_chain(self._chain_key)
        self.index += 1

        return message_key, nonce
