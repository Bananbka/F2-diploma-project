"""Reactions, pinning and mute.

None of these existed before: `is_pinned` sat unused on `MessageDocument`, there was no reaction
storage at all, and `muted_until` sat unused on `ChatParticipant`. These tests cover the
authorization chokepoint (every action still goes through `get_chat_or_403` before touching Mongo),
the toggle/dedupe semantics chosen for reactions, the role gate chosen for pinning, and the fact
that muting is local, per-user state that never reaches a WebSocket.
"""

import asyncio
import uuid

import websockets

from tests.crypto.test_authorization import _cookie_header, _private_chat
from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"
WS_BASE = "ws://localhost:8000/ws"


async def _send_message(client, chat_id) -> str:
    r = await client.post(
        "/messages/",
        json={"chat_id": str(chat_id), "encrypted_content": "hello"},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["_id"]


# --------------------------------------------------------------------------------------------
# Reactions
# --------------------------------------------------------------------------------------------


async def test_reacting_twice_with_the_same_emoji_toggles_it_off():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "👍"})
        assert r.status_code == 200, r.text
        reactions = r.json()["data"]["reactions"]
        assert len(reactions) == 1
        assert reactions[0]["emoji"] == "👍"
        assert reactions[0]["user_id"] == str(bob_id)

        # Same user, same emoji, again: toggles it off.
        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "👍"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["reactions"] == []
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_one_user_may_hold_several_different_emojis_on_one_message():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "👍"})
        assert r.status_code == 200, r.text
        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "❤️"})
        assert r.status_code == 200, r.text

        emojis = {rn["emoji"] for rn in r.json()["data"]["reactions"]}
        assert emojis == {"👍", "❤️"}
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_explicit_unreact_is_idempotent():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        # Never reacted at all: removing is still a success, not a 404.
        r = await bob.delete(f"/messages/{message_id}/reactions/%F0%9F%91%8D")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["reactions"] == []

        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "👍"})
        assert r.status_code == 200, r.text

        r = await bob.delete(f"/messages/{message_id}/reactions/%F0%9F%91%8D")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["reactions"] == []
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_reacting_requires_chat_membership():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        r = await mallory.post(f"/messages/{message_id}/reactions", json={"emoji": "👍"})
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_plain_text_emoji_is_rejected():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        for bad in ("", "lol", ":)", "x" * 9):
            r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": bad})
            assert r.status_code == 422, f"{bad!r} must be rejected: {r.text}"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_concurrent_identical_reactions_do_not_duplicate():
    """Two near-simultaneous toggles from the same user with the same emoji must not both add.

    This exercises the actual race the atomic `$pull`-then-conditional-`$push` fix closes: fired
    concurrently against a real Mongo instance rather than sequentially, so a read-then-decide
    implementation would be exposed by both requests seeing "not reacted yet" and both appending.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        responses = await asyncio.gather(
            *(
                bob.post(f"/messages/{message_id}/reactions", json={"emoji": "👍"})
                for _ in range(2)
            )
        )
        for r in responses:
            assert r.status_code == 200, r.text

        r = await alice.get(f"/chats/{chat_id}/messages")
        assert r.status_code == 200, r.text
        message = next(m for m in r.json()["data"] if m["_id"] == message_id)
        reactions = [
            rn
            for rn in message["reactions"]
            if rn["user_id"] == str(bob_id) and rn["emoji"] == "👍"
        ]
        # Exactly zero or one: the two concurrent toggles landed as add+remove (order-dependent,
        # since both are the same emoji from the same user) or, if Mongo happened to serialize
        # them such that both reached the $pull branch, as no-op+no-op. Never two.
        assert len(reactions) <= 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_reaction_broadcasts_over_websocket():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(alice)}
        ) as socket:
            r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "👍"})
            assert r.status_code == 200, r.text

            reply = await asyncio.wait_for(socket.recv(), timeout=5)
            assert "message_reaction_added" in reply
            assert message_id in reply
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------------------------
# Pinning
# --------------------------------------------------------------------------------------------


async def test_plain_member_cannot_pin_in_a_group_but_owner_can():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        # Bob joined as a plain MEMBER.
        r = await bob.post(f"/messages/{message_id}/pin")
        assert r.status_code == 403, r.text
        assert r.json()["error_code"] == "PIN_FORBIDDEN"

        r = await alice.post(f"/messages/{message_id}/pin")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_pinned"] is True
        assert r.json()["data"]["pinned_by"] == str(alice_id)

        r = await bob.post(f"/messages/{message_id}/unpin")
        assert r.status_code == 403, r.text

        r = await alice.post(f"/messages/{message_id}/unpin")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_pinned"] is False
        assert r.json()["data"]["pinned_by"] is None
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_either_side_of_a_private_chat_may_pin():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        # Both hold MEMBER in a private chat; there is no admin to defer to.
        r = await bob.post(f"/messages/{message_id}/pin")
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_pin_cap_is_enforced_per_chat():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        message_ids = [await _send_message(alice, chat_id) for _ in range(6)]

        for message_id in message_ids[:5]:
            r = await alice.post(f"/messages/{message_id}/pin")
            assert r.status_code == 200, r.text

        r = await alice.post(f"/messages/{message_ids[5]}/pin")
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "PIN_LIMIT_REACHED"

        # Unpinning one frees a slot.
        r = await alice.post(f"/messages/{message_ids[0]}/unpin")
        assert r.status_code == 200, r.text

        r = await alice.post(f"/messages/{message_ids[5]}/pin")
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_pinning_an_already_pinned_message_is_a_noop():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        r = await alice.post(f"/messages/{message_id}/pin")
        pinned_at_first = r.json()["data"]["pinned_at"]

        r = await alice.post(f"/messages/{message_id}/pin")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["pinned_at"] == pinned_at_first
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_get_pinned_messages_lists_only_pinned_ones_and_requires_membership():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        unpinned_id = await _send_message(alice, chat_id)
        pinned_id = await _send_message(alice, chat_id)

        r = await alice.post(f"/messages/{pinned_id}/pin")
        assert r.status_code == 200, r.text

        r = await bob.get(f"/chats/{chat_id}/pinned-messages")
        assert r.status_code == 200, r.text
        ids = [m["_id"] for m in r.json()["data"]]
        assert ids == [pinned_id]
        assert unpinned_id not in ids

        r = await mallory.get(f"/chats/{chat_id}/pinned-messages")
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_pin_broadcasts_over_websocket():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(bob)}
        ) as socket:
            r = await alice.post(f"/messages/{message_id}/pin")
            assert r.status_code == 200, r.text

            reply = await asyncio.wait_for(socket.recv(), timeout=5)
            assert "message_pinned" in reply
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------------------------
# Mute
# --------------------------------------------------------------------------------------------


async def test_mute_is_per_user_and_reflected_in_the_chat_list():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.patch(
            f"/chats/{chat_id}/mute", json={"muted_until": "2999-01-01T00:00:00Z"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_muted"] is True

        r = await alice.get("/chats/")
        chat = next(c for c in r.json()["data"] if c["id"] == str(chat_id))
        assert chat["is_muted"] is True

        # Bob never touched his own mute state.
        r = await bob.get("/chats/")
        chat = next(c for c in r.json()["data"] if c["id"] == str(chat_id))
        assert chat["is_muted"] is False
        assert chat["muted_until"] is None

        # Unmute: send null.
        r = await alice.patch(f"/chats/{chat_id}/mute", json={"muted_until": None})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_muted"] is False

        r = await alice.get("/chats/")
        chat = next(c for c in r.json()["data"] if c["id"] == str(chat_id))
        assert chat["is_muted"] is False
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_a_past_muted_until_reports_as_not_muted():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.patch(
            f"/chats/{chat_id}/mute", json={"muted_until": "2000-01-01T00:00:00Z"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_muted"] is False
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_muting_requires_chat_membership():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await mallory.patch(
            f"/chats/{chat_id}/mute", json={"muted_until": "2999-01-01T00:00:00Z"}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_muting_never_reaches_the_other_participant_over_websocket():
    """Mute is local, per-user state. Unlike reactions and pins, it must never fan out."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(bob)}
        ) as socket:
            r = await alice.patch(
                f"/chats/{chat_id}/mute", json={"muted_until": "2999-01-01T00:00:00Z"}
            )
            assert r.status_code == 200, r.text

            # A real event would arrive well within this window; nothing should.
            with_timeout = asyncio.wait_for(socket.recv(), timeout=2)
            try:
                reply = await with_timeout
                assert False, f"mute must not broadcast, but bob received: {reply}"
            except asyncio.TimeoutError:
                pass
    finally:
        await alice.aclose()
        await bob.aclose()
