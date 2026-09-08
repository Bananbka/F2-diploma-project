"""End-to-end: a sealed message survives the round trip and the server never sees plaintext."""
import uuid

from app.domains.crypto.reference.envelope import open_message, seal_message
from app.domains.crypto.reference.identity import generate_identity
from app.domains.crypto.reference.ratchet import ReceiverChain, SenderChain, generate_chain_key
from app.infrastructure.mongo import connect_to_mongo, mongo_client

from tests.crypto.test_identity_api import _register_user

SECRET = b"the treasure is buried under the old oak"


async def _private_chat_between(alice, bob_id):
    r = await alice.post("/chats/private", json={"target_user_id": str(bob_id)})
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["id"])


async def test_sealed_message_round_trip_and_storage_is_opaque():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _private_chat_between(alice, bob_id)

        identity = generate_identity(alice_id, uuid.uuid4())
        chain_key = generate_chain_key()
        sender = SenderChain(chain_key)
        skid = uuid.uuid4()
        epoch = 1

        mk, nonce, idx = sender.next_message_key()
        envelope = seal_message(
            message_key=mk, nonce=nonce, signing_private=identity.signing_private,
            chat_id=chat_id, epoch=epoch, sender_id=alice_id,
            sender_key_id=skid, chain_index=idx, plaintext=SECRET,
        )

        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 200, r.text

        data = r.json()["data"]
        assert data["content_format"] == "sender_keys_v1"
        assert data["is_encrypted"] is True
        assert data["encrypted_content"] is None

        # Bob reads it back and decrypts with the shared chain key.
        r = await bob.get(f"/chats/{chat_id}/messages")
        assert r.status_code == 200, r.text
        fetched = r.json()["data"][0]
        assert fetched["content_format"] == "sender_keys_v1"

        recovered = open_message(
            message_key=ReceiverChain(chain_key).message_key_for(fetched["envelope"]["idx"])[0],
            envelope=fetched["envelope"], chat_id=chat_id, sender_id=alice_id,
            signing_public=identity.signing_public,
        )
        assert recovered == SECRET

        # The stored document must contain no trace of the plaintext.
        await connect_to_mongo()
        doc = await mongo_client.db["messages"].find_one({"chat_id": chat_id})
        assert doc is not None
        assert doc["content_format"] == "sender_keys_v1"
        assert doc.get("encrypted_content") is None
        assert SECRET not in repr(doc).encode()
        assert b"treasure" not in repr(doc).encode()
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_legacy_plaintext_still_works_and_is_flagged():
    """Existing group flows must keep working, but must not claim to be encrypted."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        r = await alice.post("/chats/group", json={
            "title": "Legacy", "description": "d", "participant_ids": [str(bob_id)],
        })
        assert r.status_code == 200, r.text
        chat_id = r.json()["data"]["id"]

        r = await alice.post("/messages/", json={
            "chat_id": chat_id, "encrypted_content": "hello in the clear",
        })
        assert r.status_code == 200, r.text

        data = r.json()["data"]
        # The old code reported is_encrypted=True here because the computed value was dropped.
        assert data["content_format"] == "legacy_plaintext"
        assert data["is_encrypted"] is False
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_chat_list_survives_envelope_messages():
    """enrich_chats_with_mongo_data returns last_message as the raw document, so the envelope
    shape must not break the sidebar aggregation or the unread pipeline."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _private_chat_between(alice, bob_id)

        identity = generate_identity(alice_id, uuid.uuid4())
        sender = SenderChain(generate_chain_key())
        mk, nonce, idx = sender.next_message_key()
        envelope = seal_message(
            message_key=mk, nonce=nonce, signing_private=identity.signing_private,
            chat_id=chat_id, epoch=1, sender_id=alice_id,
            sender_key_id=uuid.uuid4(), chain_index=idx, plaintext=SECRET,
        )
        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 200, r.text

        r = await bob.get("/chats/")
        assert r.status_code == 200, r.text

        chat = next(c for c in r.json()["data"] if c["id"] == str(chat_id))
        assert chat["unread_count"] == 1, "unread counting keys off ObjectId, not content"

        last = chat["last_message"]
        assert last["content_format"] == "sender_keys_v1"
        # The preview is an opaque blob: the client must decrypt it to render anything.
        assert last.get("encrypted_content") is None
        assert SECRET not in repr(last).encode()
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_message_requires_exactly_one_content_form():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _private_chat_between(alice, bob_id)

        r = await alice.post("/messages/", json={"chat_id": str(chat_id)})
        assert r.status_code == 422

        r = await alice.post("/messages/", json={
            "chat_id": str(chat_id),
            "encrypted_content": "x",
            "envelope": {"v": 1, "alg": "A256GCM-SK1", "epoch": 1, "skid": str(uuid.uuid4()),
                         "idx": 0, "n": "AAAA", "ct": "AAAA", "sig": "AAAA"},
        })
        assert r.status_code == 422
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_edit_rejects_reused_chain_index():
    """Reusing a chain index would repeat a (key, nonce) pair — catastrophic for GCM."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _private_chat_between(alice, bob_id)

        identity = generate_identity(alice_id, uuid.uuid4())
        sender = SenderChain(generate_chain_key())
        skid = uuid.uuid4()

        mk, nonce, idx = sender.next_message_key()
        envelope = seal_message(
            message_key=mk, nonce=nonce, signing_private=identity.signing_private,
            chat_id=chat_id, epoch=1, sender_id=alice_id,
            sender_key_id=skid, chain_index=idx, plaintext=b"original",
        )
        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 200, r.text
        # FastAPI serialises response models by alias, so the id field comes back as "_id".
        message_id = r.json()["data"]["_id"]

        # Edit re-using index 0.
        r = await alice.put(f"/messages/{message_id}", json={"envelope": dict(envelope, ct="QUJD")})
        assert r.status_code == 400
        assert r.json()["error_code"] == "CHAIN_INDEX_REUSED"

        # A fresh index is accepted.
        mk2, nonce2, idx2 = sender.next_message_key()
        edited = seal_message(
            message_key=mk2, nonce=nonce2, signing_private=identity.signing_private,
            chat_id=chat_id, epoch=1, sender_id=alice_id,
            sender_key_id=skid, chain_index=idx2, plaintext=b"edited",
        )
        r = await alice.put(f"/messages/{message_id}", json={"envelope": edited})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_edited"] is True
        assert r.json()["data"]["envelope"]["idx"] == idx2
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_edit_from_a_fresh_chain_is_accepted():
    """An edit sealed under a NEW chain may start at index 0.

    An index only identifies a key within one chain: each sender_key_id has its own random chain key,
    so index 0 of a new chain is a different key from index 0 of the old one and no (key, nonce) pair
    repeats. This is the ordinary case, not an edge one — chain state is memory-only, so a client that
    has reloaded mints a fresh chain and its first send is index 0. Comparing bare indices rejected
    every such edit.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _private_chat_between(alice, bob_id)
        identity = generate_identity(alice_id, uuid.uuid4())

        # Original, sent well into the first chain so its index is comfortably above zero.
        first_chain = SenderChain(generate_chain_key())
        first_skid = uuid.uuid4()
        for _ in range(4):
            first_chain.next_message_key()

        mk, nonce, idx = first_chain.next_message_key()
        assert idx > 0
        envelope = seal_message(
            message_key=mk, nonce=nonce, signing_private=identity.signing_private,
            chat_id=chat_id, epoch=1, sender_id=alice_id,
            sender_key_id=first_skid, chain_index=idx, plaintext=b"original",
        )
        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        # The client reloaded: new chain, new key, index back to 0.
        second_chain = SenderChain(generate_chain_key())
        second_skid = uuid.uuid4()
        mk2, nonce2, idx2 = second_chain.next_message_key()
        assert idx2 == 0

        edited = seal_message(
            message_key=mk2, nonce=nonce2, signing_private=identity.signing_private,
            chat_id=chat_id, epoch=1, sender_id=alice_id,
            sender_key_id=second_skid, chain_index=idx2, plaintext=b"edited",
        )
        r = await alice.put(f"/messages/{message_id}", json={"envelope": edited})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_edited"] is True
        assert r.json()["data"]["envelope"]["skid"] == str(second_skid)

        # Reuse within that new chain is still refused — the rule is scoped, not removed.
        r = await alice.put(f"/messages/{message_id}", json={"envelope": dict(edited, ct="QUJD")})
        assert r.status_code == 400
        assert r.json()["error_code"] == "CHAIN_INDEX_REUSED"
    finally:
        await alice.aclose()
        await bob.aclose()
