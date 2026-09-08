"""Envelope sealing and the AAD binding.

The negative tests are the point: each one tampers with exactly one bound field and asserts the
open fails. If any of them starts passing, the binding has been weakened and a malicious server can
relocate ciphertexts.
"""
import uuid

import pytest
from cryptography.exceptions import InvalidSignature

from app.domains.crypto.reference.envelope import (
    ALGORITHM,
    build_message_aad,
    open_message,
    seal_message,
    verify_envelope_signature,
)
from app.domains.crypto.reference.identity import generate_identity
from app.domains.crypto.reference.primitives import b64u_decode, b64u_encode
from app.domains.crypto.reference.ratchet import ReceiverChain, SenderChain, generate_chain_key

CHAT = uuid.UUID("33333333-3333-3333-3333-333333333333")
OTHER_CHAT = uuid.UUID("44444444-4444-4444-4444-444444444444")
SENDER = uuid.UUID("55555555-5555-5555-5555-555555555555")
OTHER_SENDER = uuid.UUID("66666666-6666-6666-6666-666666666666")
SKID = uuid.UUID("77777777-7777-7777-7777-777777777777")
EPOCH = 5


def _sealed(plaintext=b"attack at dawn", epoch=EPOCH, chat_id=CHAT, sender_id=SENDER):
    identity = generate_identity(SENDER, uuid.uuid4())
    ck = generate_chain_key()
    sender = SenderChain(ck)
    mk, nonce, idx = sender.next_message_key()

    envelope = seal_message(
        message_key=mk, nonce=nonce, signing_private=identity.signing_private,
        chat_id=chat_id, epoch=epoch, sender_id=sender_id,
        sender_key_id=SKID, chain_index=idx, plaintext=plaintext,
    )
    return envelope, identity, ck


def test_aad_is_exactly_65_bytes_and_layout_is_stable():
    aad = build_message_aad(CHAT, EPOCH, SENDER, SKID, 42)

    assert len(aad) == 65
    assert aad.startswith(b"NS-v1-msg")
    assert aad[9:25] == CHAT.bytes
    assert aad[25:29] == (5).to_bytes(4, "big")
    assert aad[29:45] == SENDER.bytes
    assert aad[45:61] == SKID.bytes
    assert aad[61:65] == (42).to_bytes(4, "big")


def test_round_trip():
    envelope, identity, ck = _sealed(b"hello world")

    plaintext = open_message(
        message_key=ReceiverChain(ck).message_key_for(0)[0],
        envelope=envelope, chat_id=CHAT, sender_id=SENDER,
        signing_public=identity.signing_public,
    )
    assert plaintext == b"hello world"


def test_envelope_shape():
    envelope, _, _ = _sealed()

    assert envelope["v"] == 1
    assert envelope["alg"] == ALGORITHM
    assert envelope["epoch"] == EPOCH
    assert envelope["idx"] == 0
    assert len(b64u_decode(envelope["n"])) == 12
    assert len(b64u_decode(envelope["sig"])) == 64
    # The ciphertext must not contain the plaintext in any recognisable form.
    assert b"attack" not in b64u_decode(envelope["ct"])


def test_ciphertext_cannot_be_moved_to_another_chat():
    """The headline attack: a malicious server relocating a message into a chat it controls."""
    envelope, identity, ck = _sealed()

    with pytest.raises(Exception):
        open_message(
            message_key=ReceiverChain(ck).message_key_for(0)[0],
            envelope=envelope, chat_id=OTHER_CHAT, sender_id=SENDER,
        )


def test_ciphertext_cannot_be_reattributed_to_another_sender():
    envelope, identity, ck = _sealed()

    with pytest.raises(Exception):
        open_message(
            message_key=ReceiverChain(ck).message_key_for(0)[0],
            envelope=envelope, chat_id=CHAT, sender_id=OTHER_SENDER,
        )


def test_ciphertext_cannot_be_replayed_into_a_later_epoch():
    """Blocks replaying a pre-removal message after a member was removed and keys rotated."""
    envelope, identity, ck = _sealed()
    tampered = dict(envelope, epoch=EPOCH + 1)

    with pytest.raises(Exception):
        open_message(
            message_key=ReceiverChain(ck).message_key_for(0)[0],
            envelope=tampered, chat_id=CHAT, sender_id=SENDER,
        )


def test_chain_index_cannot_be_shifted():
    envelope, identity, ck = _sealed()
    tampered = dict(envelope, idx=1)

    with pytest.raises(Exception):
        open_message(
            message_key=ReceiverChain(ck).message_key_for(0)[0],
            envelope=tampered, chat_id=CHAT, sender_id=SENDER,
        )


def test_tampered_ciphertext_is_rejected():
    envelope, identity, ck = _sealed()

    raw = bytearray(b64u_decode(envelope["ct"]))
    raw[0] ^= 0x01
    tampered = dict(envelope, ct=b64u_encode(bytes(raw)))

    with pytest.raises(Exception):
        open_message(
            message_key=ReceiverChain(ck).message_key_for(0)[0],
            envelope=tampered, chat_id=CHAT, sender_id=SENDER,
        )


def test_signature_verifies_and_detects_forgery():
    envelope, identity, _ = _sealed()

    assert verify_envelope_signature(
        envelope=envelope, signing_public=identity.signing_public,
        chat_id=CHAT, sender_id=SENDER,
    )

    # A different identity must not validate — this is what stops forged attribution.
    impostor = generate_identity(OTHER_SENDER, uuid.uuid4())
    assert not verify_envelope_signature(
        envelope=envelope, signing_public=impostor.signing_public,
        chat_id=CHAT, sender_id=SENDER,
    )


def test_signature_is_bound_to_chat_and_sender():
    """A valid signature must not verify once the envelope is relocated."""
    envelope, identity, _ = _sealed()

    assert not verify_envelope_signature(
        envelope=envelope, signing_public=identity.signing_public,
        chat_id=OTHER_CHAT, sender_id=SENDER,
    )
    assert not verify_envelope_signature(
        envelope=envelope, signing_public=identity.signing_public,
        chat_id=CHAT, sender_id=OTHER_SENDER,
    )


def test_open_rejects_bad_signature_before_decrypting():
    envelope, _, ck = _sealed()
    impostor = generate_identity(OTHER_SENDER, uuid.uuid4())

    with pytest.raises(InvalidSignature):
        open_message(
            message_key=ReceiverChain(ck).message_key_for(0)[0],
            envelope=envelope, chat_id=CHAT, sender_id=SENDER,
            signing_public=impostor.signing_public,
        )


def test_multi_message_conversation_round_trips_in_order():
    identity = generate_identity(SENDER, uuid.uuid4())
    ck = generate_chain_key()
    sender, receiver = SenderChain(ck), ReceiverChain(ck)

    bodies = [f"message {i}".encode() for i in range(10)]
    envelopes = []

    for body in bodies:
        mk, nonce, idx = sender.next_message_key()
        envelopes.append(seal_message(
            message_key=mk, nonce=nonce, signing_private=identity.signing_private,
            chat_id=CHAT, epoch=EPOCH, sender_id=SENDER,
            sender_key_id=SKID, chain_index=idx, plaintext=body,
        ))

    for expected, envelope in zip(bodies, envelopes):
        mk, _ = receiver.message_key_for(envelope["idx"])
        assert open_message(
            message_key=mk, envelope=envelope, chat_id=CHAT, sender_id=SENDER,
            signing_public=identity.signing_public,
        ) == expected
