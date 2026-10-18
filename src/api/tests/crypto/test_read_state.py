"""Per-user read state: `GET /chats/{id}/read-state`, its authorization, and the WebSocket
broadcast that keeps it live.

This is the feature that replaces the single shared `MessageDocument.is_read` boolean, whose
documented failure mode was that one member reading a group message marked it read for everyone
else. The regression test at the bottom proves that failure mode is gone: each participant's
`last_read_message_id` moves independently.
"""

import asyncio
import uuid

import httpx
import websockets

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"
WS_BASE = "ws://localhost:8000/ws"


async def _private_chat(client, peer_id) -> uuid.UUID:
    r = await client.post("/chats/private", json={"target_user_id": str(peer_id)})
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["id"])


async def _send(client: httpx.AsyncClient, chat_id: uuid.UUID, text: str) -> str:
    r = await client.post(
        "/messages/", json={"chat_id": str(chat_id), "encrypted_content": text}
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["_id"]


def _cookie_header(client: httpx.AsyncClient) -> str:
    return "; ".join(f"{k}={v}" for k, v in client.cookies.items())


async def _mark_read(client: httpx.AsyncClient, chat_id: uuid.UUID, message_id: str) -> str:
    """Mark read over the WebSocket, the same path the client uses, and wait for the ack-less
    round trip to land server-side before returning."""
    async with websockets.connect(
        WS_BASE, additional_headers={"Cookie": _cookie_header(client)}
    ) as socket:
        await socket.send(
            f'{{"event_type":"message_read","chat_id":"{chat_id}",'
            f'"payload":{{"last_read_message_id":"{message_id}"}}}}'
        )
        # No explicit ack is sent back to the sender on success (only on error), so give the
        # server a moment to finish the Postgres write before the socket closes underneath it.
        await asyncio.sleep(0.3)
    return message_id


async def _read_state(client: httpx.AsyncClient, chat_id: uuid.UUID) -> dict:
    r = await client.get(f"/chats/{chat_id}/read-state")
    assert r.status_code == 200, r.text
    return {row["user_id"]: row["last_read_message_id"] for row in r.json()["data"]}


async def test_read_state_reflects_each_participants_own_high_water_mark():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)

        msg1 = await _send(alice, chat_id, "hello")
        msg2 = await _send(alice, chat_id, "again")

        state = await _read_state(alice, chat_id)
        assert state[str(bob_id)] is None, "bob has not read anything yet"

        await _mark_read(bob, chat_id, msg1)

        state = await _read_state(alice, chat_id)
        assert state[str(bob_id)] == msg1

        await _mark_read(bob, chat_id, msg2)

        state = await _read_state(alice, chat_id)
        assert state[str(bob_id)] == msg2
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_read_state_rejects_a_non_member():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)

        r = await mallory.get(f"/chats/{chat_id}/read-state")
        assert r.status_code == 403, r.text
        assert r.json()["error_code"] == "ACCESS_DENIED"
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_read_state_404_style_chat_still_403s_for_outsider():
    """A chat that exists but the caller never joined must read as forbidden, not silently empty."""
    alice, alice_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        # alice + a throwaway third party, carol excluded entirely.
        other, other_id = await _register_user()
        chat_id = await _private_chat(alice, other_id)

        r = await carol.get(f"/chats/{chat_id}/read-state")
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await carol.aclose()


async def test_message_read_broadcast_reaches_other_participants():
    """Marking a chat read publishes `message_read` to every participant, not just the reader —
    this is what lets a peer's client move a sent tick to a read tick without polling."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)
        msg_id = await _send(bob, chat_id, "read me")

        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(alice)}
        ) as alice_socket:
            async with websockets.connect(
                WS_BASE, additional_headers={"Cookie": _cookie_header(bob)}
            ) as bob_socket:
                await alice_socket.send(
                    f'{{"event_type":"message_read","chat_id":"{chat_id}",'
                    f'"payload":{{"last_read_message_id":"{msg_id}"}}}}'
                )

                # Bob (the other participant, and the message's sender) must be told alice read
                # up to this point.
                reply = await asyncio.wait_for(bob_socket.recv(), timeout=5.0)
                assert '"message_read"' in reply
                assert str(alice_id) in reply
                assert msg_id in reply
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_one_members_read_does_not_advance_another_members_state():
    """The exact bug this feature exists to fix: `is_read` was one boolean per message, so the
    first group member to read a message marked it read for every other member too. Each
    participant's `last_read_message_id` must move independently."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(
            f"/chats/{chat_id}/add-participants", json={"user_ids": [str(carol_id)]}
        )
        assert r.status_code == 200, r.text

        msg_id = await _send(alice, chat_id, "group message")

        # Only Bob reads it.
        await _mark_read(bob, chat_id, msg_id)

        state = await _read_state(alice, chat_id)
        assert state[str(bob_id)] == msg_id, "bob's own mark must advance"
        assert state[str(carol_id)] is None, (
            "carol never read anything — her mark must be untouched by bob's read"
        )

        # Carol reads independently, afterwards.
        await _mark_read(carol, chat_id, msg_id)

        state = await _read_state(alice, chat_id)
        assert state[str(bob_id)] == msg_id
        assert state[str(carol_id)] == msg_id
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_garbage_read_id_is_rejected_without_touching_postgres():
    """A non-ObjectId `last_read_message_id` must be rejected before it ever reaches Postgres —
    not committed and then only caught later by `mark_messages_as_read`'s own validation, which
    runs too late to undo the write."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)
        await _send(alice, chat_id, "hello")

        state_before = await _read_state(alice, chat_id)
        assert state_before[str(bob_id)] is None

        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(bob)}
        ) as socket:
            await socket.send(
                f'{{"event_type":"message_read","chat_id":"{chat_id}",'
                f'"payload":{{"last_read_message_id":"not-an-object-id"}}}}'
            )
            reply = await asyncio.wait_for(socket.recv(), timeout=5.0)
            assert '"error"' in reply
            assert "INVALID_ID" in reply

        state_after = await _read_state(alice, chat_id)
        assert state_after[str(bob_id)] is None, (
            "a rejected id must leave the participant's read mark untouched"
        )
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_case_variant_object_id_is_normalized():
    """An uppercase-hex ObjectId is valid per `bson.ObjectId` but must be stored in its canonical
    lowercase form, so it byte-compares consistently against genuine (lowercase) ObjectId strings
    produced by Mongo elsewhere in the ordering guard."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)
        msg_id = await _send(alice, chat_id, "hello")

        await _mark_read(bob, chat_id, msg_id.upper())

        state = await _read_state(alice, chat_id)
        assert state[str(bob_id)] == msg_id.lower(), (
            "the stored mark must be the canonical lowercase form, regardless of input case"
        )
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_read_mark_does_not_regress_on_out_of_order_delivery():
    """A later `message_read` frame for an older message id must not move the mark backwards."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)
        msg1 = await _send(alice, chat_id, "one")
        msg2 = await _send(alice, chat_id, "two")

        await _mark_read(bob, chat_id, msg2)
        await _mark_read(bob, chat_id, msg1)

        state = await _read_state(alice, chat_id)
        assert state[str(bob_id)] == msg2, "an older ack must not regress the mark"
    finally:
        await alice.aclose()
        await bob.aclose()
