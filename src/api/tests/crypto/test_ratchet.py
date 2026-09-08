"""Ratchet behaviour: forward secrecy, out-of-order tolerance, and DoS bounds."""
import pytest

from app.domains.crypto.reference.ratchet import (
    MAX_SKIP,
    ReceiverChain,
    SenderChain,
    advance_chain,
    derive_message_key,
    generate_chain_key,
)


def test_derivation_shapes():
    ck = generate_chain_key()
    mk, nonce = derive_message_key(ck)

    assert len(ck) == 32
    assert len(mk) == 32
    assert len(nonce) == 12


def test_derivation_is_deterministic():
    """Both sides must derive identical keys from the same chain key, or nothing decrypts."""
    ck = generate_chain_key()
    assert derive_message_key(ck) == derive_message_key(ck)
    assert advance_chain(ck) == advance_chain(ck)


def test_chain_advances_to_distinct_keys():
    ck = generate_chain_key()
    seen_chain = set()
    seen_message = set()

    for _ in range(50):
        mk, nonce = derive_message_key(ck)
        seen_message.add(mk)
        seen_chain.add(ck)
        ck = advance_chain(ck)

    assert len(seen_chain) == 50
    assert len(seen_message) == 50, "every index must yield a distinct message key"


def test_message_key_differs_from_chain_key():
    """The message key must not equal the chain key, or leaking one leaks the whole future chain."""
    ck = generate_chain_key()
    mk, _ = derive_message_key(ck)
    assert mk != ck
    assert mk != advance_chain(ck)


def test_nonce_uniqueness_across_chain():
    """Derived nonces make GCM (key, nonce) reuse structurally impossible."""
    ck = generate_chain_key()
    pairs = set()

    for _ in range(200):
        mk, nonce = derive_message_key(ck)
        pairs.add((mk, nonce))
        ck = advance_chain(ck)

    assert len(pairs) == 200


def test_sender_and_receiver_stay_in_lockstep():
    ck = generate_chain_key()
    sender = SenderChain(ck)
    receiver = ReceiverChain(ck)

    for expected_index in range(20):
        mk_s, nonce_s, idx = sender.next_message_key()
        assert idx == expected_index

        mk_r, nonce_r = receiver.message_key_for(idx)
        assert mk_s == mk_r and nonce_s == nonce_r


def test_receiver_handles_out_of_order_delivery():
    """Messages 3..5 arrive before 0..2; all must still open."""
    ck = generate_chain_key()
    sender = SenderChain(ck)
    receiver = ReceiverChain(ck)

    sent = [sender.next_message_key() for _ in range(6)]

    for mk, nonce, idx in sent[3:]:
        assert receiver.message_key_for(idx) == (mk, nonce)

    for mk, nonce, idx in sent[:3]:
        assert receiver.message_key_for(idx) == (mk, nonce), "skipped keys must be retained"


def test_receiver_refuses_to_reuse_a_consumed_key():
    """Replaying an index must fail rather than silently decrypt again."""
    ck = generate_chain_key()
    receiver = ReceiverChain(ck)

    receiver.message_key_for(0)
    with pytest.raises(ValueError, match="already consumed"):
        receiver.message_key_for(0)


def test_receiver_bounds_skip_distance():
    """An attacker claiming a huge index must not force unbounded HKDF work."""
    receiver = ReceiverChain(generate_chain_key())

    with pytest.raises(ValueError, match="refusing to skip"):
        receiver.message_key_for(MAX_SKIP + 1)


def test_sender_discards_previous_chain_key():
    """Forward secrecy: after emitting index i, the chain key that produced it is gone."""
    ck = generate_chain_key()
    sender = SenderChain(ck)

    mk_first, _, _ = sender.next_message_key()

    # The sender's internal state has moved on; re-deriving from it cannot reproduce index 0.
    mk_second, _, _ = sender.next_message_key()
    assert mk_first != mk_second
    assert sender.index == 2
