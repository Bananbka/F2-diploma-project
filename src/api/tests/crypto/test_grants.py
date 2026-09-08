"""Grant wrapping, distribution signatures, and the member set hash."""
import uuid

import pytest

from app.domains.crypto.reference.grants import (
    build_grant_aad,
    compute_member_set_hash,
    sign_distribution,
    unwrap_chain_key,
    verify_distribution,
    wrap_chain_key,
)
from app.domains.crypto.reference.identity import generate_identity
from app.domains.crypto.reference.primitives import b64u_decode, b64u_encode
from app.domains.crypto.reference.ratchet import generate_chain_key

CHAT = uuid.UUID("33333333-3333-3333-3333-333333333333")
OTHER_CHAT = uuid.UUID("44444444-4444-4444-4444-444444444444")
SKID = uuid.UUID("77777777-7777-7777-7777-777777777777")
SENDER_DEV = uuid.UUID("88888888-8888-8888-8888-888888888888")
RECIP_DEV = uuid.UUID("99999999-9999-9999-9999-999999999999")
OTHER_DEV = uuid.UUID("aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa")
EPOCH = 3


def _wrap(recipient, chain_key, *, chat_id=CHAT, epoch=EPOCH, recipient_device_id=RECIP_DEV):
    return wrap_chain_key(
        chain_key=chain_key, chain_start_index=0,
        recipient_public=recipient.identity_public,
        chat_id=chat_id, epoch=epoch, sender_key_id=SKID,
        sender_device_id=SENDER_DEV, recipient_device_id=recipient_device_id,
    )


def _unwrap(recipient, eph, wrapped, *, chat_id=CHAT, epoch=EPOCH, recipient_device_id=RECIP_DEV):
    return unwrap_chain_key(
        wrapped=wrapped, ephemeral_public=eph,
        recipient_private=recipient.identity_private,
        chat_id=chat_id, epoch=epoch, sender_key_id=SKID,
        sender_device_id=SENDER_DEV, recipient_device_id=recipient_device_id,
    )


def test_wrap_unwrap_round_trip():
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    chain_key = generate_chain_key()

    eph, wrapped = _wrap(recipient, chain_key)
    recovered, start_index = _unwrap(recipient, eph, wrapped)

    assert recovered == chain_key
    assert start_index == 0


def test_wrap_preserves_start_index():
    """Ratchet-forward grants hand over a chain mid-stream, so the index must survive."""
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    chain_key = generate_chain_key()

    eph, wrapped = wrap_chain_key(
        chain_key=chain_key, chain_start_index=17,
        recipient_public=recipient.identity_public,
        chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
        sender_device_id=SENDER_DEV, recipient_device_id=RECIP_DEV,
    )
    recovered, start_index = _unwrap(recipient, eph, wrapped)

    assert recovered == chain_key
    assert start_index == 17


def test_each_wrap_uses_a_fresh_ephemeral():
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    chain_key = generate_chain_key()

    eph1, w1 = _wrap(recipient, chain_key)
    eph2, w2 = _wrap(recipient, chain_key)

    assert eph1 != eph2
    assert w1 != w2, "same key wrapped twice must not produce identical ciphertext"


def test_wrong_recipient_cannot_unwrap():
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    attacker = generate_identity(uuid.uuid4(), OTHER_DEV)
    chain_key = generate_chain_key()

    eph, wrapped = _wrap(recipient, chain_key)

    with pytest.raises(Exception):
        _unwrap(attacker, eph, wrapped)


def test_grant_cannot_be_relocated_to_another_chat():
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    chain_key = generate_chain_key()
    eph, wrapped = _wrap(recipient, chain_key)

    with pytest.raises(Exception):
        _unwrap(recipient, eph, wrapped, chat_id=OTHER_CHAT)


def test_grant_cannot_be_replayed_into_another_epoch():
    """Blocks reusing a pre-rotation grant after a member was removed."""
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    chain_key = generate_chain_key()
    eph, wrapped = _wrap(recipient, chain_key)

    with pytest.raises(Exception):
        _unwrap(recipient, eph, wrapped, epoch=EPOCH + 1)


def test_grant_cannot_be_readdressed_to_another_device():
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    chain_key = generate_chain_key()
    eph, wrapped = _wrap(recipient, chain_key)

    with pytest.raises(Exception):
        _unwrap(recipient, eph, wrapped, recipient_device_id=OTHER_DEV)


def test_tampered_wrapped_key_is_rejected():
    recipient = generate_identity(uuid.uuid4(), RECIP_DEV)
    chain_key = generate_chain_key()
    eph, wrapped = _wrap(recipient, chain_key)

    raw = bytearray(b64u_decode(wrapped))
    raw[-1] ^= 0x01

    with pytest.raises(Exception):
        _unwrap(recipient, eph, b64u_encode(bytes(raw)))


def test_grant_aad_layout():
    aad = build_grant_aad(
        chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
        sender_device_id=SENDER_DEV, recipient_device_id=RECIP_DEV,
        ephemeral_public=b"\x01" * 32,
    )

    assert aad.startswith(b"NS-v1-grant")
    assert len(aad) == 11 + 16 + 4 + 16 + 16 + 16 + 32


def test_distribution_signature_round_trip():
    identity = generate_identity(uuid.uuid4(), SENDER_DEV)
    chain_identity = generate_identity(uuid.uuid4(), uuid.uuid4())

    signature = sign_distribution(
        identity_signing_private=identity.signing_private,
        chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
        chain_signing_public=chain_identity.signing_public, chain_start_index=0,
    )

    assert verify_distribution(
        identity_signing_public=identity.signing_public, signature=signature,
        chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
        chain_signing_public=chain_identity.signing_public, chain_start_index=0,
    )


def test_distribution_signature_is_bound_to_chat_and_epoch():
    """A server must not be able to move a distribution into another chat or epoch."""
    identity = generate_identity(uuid.uuid4(), SENDER_DEV)
    chain_identity = generate_identity(uuid.uuid4(), uuid.uuid4())

    signature = sign_distribution(
        identity_signing_private=identity.signing_private,
        chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
        chain_signing_public=chain_identity.signing_public, chain_start_index=0,
    )

    for kwargs in (
            {"chat_id": OTHER_CHAT},
            {"epoch": EPOCH + 1},
            {"sender_key_id": uuid.uuid4()},
    ):
        base = dict(
            identity_signing_public=identity.signing_public, signature=signature,
            chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
            chain_signing_public=chain_identity.signing_public, chain_start_index=0,
        )
        base.update(kwargs)
        assert not verify_distribution(**base)


def test_distribution_signature_detects_substituted_chain_key():
    """The core forgery: server swaps in its own chain signing key."""
    identity = generate_identity(uuid.uuid4(), SENDER_DEV)
    real = generate_identity(uuid.uuid4(), uuid.uuid4())
    forged = generate_identity(uuid.uuid4(), uuid.uuid4())

    signature = sign_distribution(
        identity_signing_private=identity.signing_private,
        chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
        chain_signing_public=real.signing_public, chain_start_index=0,
    )

    assert not verify_distribution(
        identity_signing_public=identity.signing_public, signature=signature,
        chat_id=CHAT, epoch=EPOCH, sender_key_id=SKID,
        chain_signing_public=forged.signing_public, chain_start_index=0,
    )


def test_member_set_hash_is_order_independent():
    devices = [uuid.uuid4() for _ in range(5)]

    assert compute_member_set_hash(devices) == compute_member_set_hash(list(reversed(devices)))
    assert compute_member_set_hash(devices) == compute_member_set_hash([str(d) for d in devices])


def test_member_set_hash_detects_a_ghost_device():
    """This is what makes a silently-inserted member visible to clients."""
    devices = [uuid.uuid4() for _ in range(4)]
    ghost = devices + [uuid.uuid4()]

    assert compute_member_set_hash(devices) != compute_member_set_hash(ghost)


def test_member_set_hash_detects_a_removed_device():
    devices = [uuid.uuid4() for _ in range(4)]

    assert compute_member_set_hash(devices) != compute_member_set_hash(devices[:-1])
