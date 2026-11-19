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
from tests.crypto.sealing import send_sealed
from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"
WS_BASE = "ws://localhost:8000/ws"


async def _send_message(client, chat_id) -> str:
    r = await send_sealed(client, chat_id, "hello")
    assert r.status_code == 201, r.text
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
            WS_BASE, additional_headers={
                "Cookie": _cookie_header(alice),
                "Origin": "http://localhost:4200",
            }
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
            WS_BASE, additional_headers={
                "Cookie": _cookie_header(bob),
                "Origin": "http://localhost:4200",
            }
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
            WS_BASE, additional_headers={
                "Cookie": _cookie_header(bob),
                "Origin": "http://localhost:4200",
            }
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


# --------------------------------------------------------------------------------------------
# Reaction caps and emoji validation (audit finding B-M4)
#
# Reactions are stored inline on the message document. Unbounded, one member could grow a single
# document toward MongoDB's 16 MB limit, after which every update to it fails for the whole chat.
# --------------------------------------------------------------------------------------------


async def _stored_reactions(message_id: str) -> list[dict]:
    from bson import ObjectId

    from app.infrastructure.mongo import connect_to_mongo, mongo_client

    await connect_to_mongo()
    doc = await mongo_client.db["messages"].find_one({"_id": ObjectId(message_id)})
    return doc.get("reactions") or []


async def _seed_reactions(message_id: str, reactions: list[tuple[uuid.UUID, str]]) -> None:
    """Write reactions straight to Mongo, as if other members had placed them."""
    import datetime

    from bson import ObjectId

    from app.infrastructure.mongo import connect_to_mongo, mongo_client

    await connect_to_mongo()
    now = datetime.datetime.now(datetime.timezone.utc)
    await mongo_client.db["messages"].update_one(
        {"_id": ObjectId(message_id)},
        {
            "$push": {
                "reactions": {
                    "$each": [
                        {"user_id": user_id, "emoji": emoji, "created_at": now}
                        for user_id, emoji in reactions
                    ]
                }
            }
        },
    )


# 21 distinct, all valid under the validator.
_DISTINCT = [
    "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉",
    "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "🥲",
]


def test_emoji_validator_accepts_what_the_client_picker_sends():
    """Every shape the Angular picker can produce: plain, VS16, skin-toned (the picker strips VS16
    and inserts the modifier after the first code point), ZWJ sequences, flags, subdivision flags
    and keycaps. If this fails, honest clients get a 422 on a reaction they were offered."""
    from app.domains.messages.schemas.messages_schemas import validate_emoji

    accepted = [
        "👍", "❤️", "❤", "😂", "💀", "🍌", "☺️", "✌️", "ℹ️", "©️", "™️", "〰️", "㊗️", "⬆️", "↔️",
        "👍🏽", "✌🏻", "☝🏿", "🕵🏻‍♂", "⛹🏾‍♀",
        "😶‍🌫️", "😮‍💨", "❤️‍🔥", "🏳️‍🌈", "🏴‍☠️", "🧑‍💻",
        "👨‍👩‍👧‍👦",
        "👩🏽‍❤️‍💋‍👨🏽",
        "🇺🇦", "🇯🇵",
        "🏴\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f",
        "#️⃣", "*️⃣", "7️⃣",
        "🫠", "🫨", "🪿",
    ]
    for emoji in accepted:
        assert validate_emoji(emoji) == emoji, f"{emoji!r} must be accepted"

    # Surrounding whitespace is trimmed, not rejected.
    assert validate_emoji(" 👍 ") == "👍"


def test_emoji_validator_rejects_everything_that_is_not_one_emoji():
    import pytest

    from app.domains.messages.schemas.messages_schemas import validate_emoji

    rejected = [
        "", "   ", "lol", ":)", "1", "#",
        # Non-ASCII text passed the old "any non-ASCII code point" check.
        "é", "привіт", "日本", "́̂",
        # Private use, lone joiners/selectors/modifiers: the cheap way to mint distinct "emoji".
        "", "\U000f0000", "‍", "️", "🏻", "\U0001f1fa", "⃣",
        # More than one emoji, or an emoji with text attached.
        "👍👍", "a👍", "👍a", "👍‍", "‍👍", "👍️️",
        "🇺🇦🇺", "👍" * 5,
        # Five ZWJ-joined elements: longer than any real sequence.
        "‍".join(["👨"] * 5),
    ]
    for bad in rejected:
        with pytest.raises(ValueError):
            validate_emoji(bad)


async def test_non_emoji_unicode_is_rejected_over_http():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        for bad in ("é", "привіт", "", "👍👍", "‍", "🏻"):
            r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": bad})
            assert r.status_code == 422, f"{bad!r} must be rejected: {r.text}"

        assert await _stored_reactions(message_id) == []

        # A ten-code-point sequence the old 8-character cap refused.
        r = await bob.post(
            f"/messages/{message_id}/reactions",
            json={"emoji": "👩🏽‍❤️‍💋‍👨🏽"},
        )
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_a_user_is_capped_at_three_reactions_per_message_and_can_still_remove():
    from app.domains.messages.services.messages_service import MAX_REACTIONS_PER_USER

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        held = _DISTINCT[:MAX_REACTIONS_PER_USER]
        for emoji in held:
            r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": emoji})
            assert r.status_code == 200, r.text

        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "🔥"})
        assert r.status_code == 409, r.text
        assert r.json()["error_code"] == "REACTION_LIMIT_REACHED"

        # The cap is per user, not per message: Alice is unaffected.
        r = await alice.post(f"/messages/{message_id}/reactions", json={"emoji": "🔥"})
        assert r.status_code == 200, r.text

        # At the cap, toggling an emoji Bob already holds removes it...
        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": held[0]})
        assert r.status_code == 200, r.text
        mine = [rn["emoji"] for rn in r.json()["data"]["reactions"] if rn["user_id"] == str(bob_id)]
        assert sorted(mine) == sorted(held[1:])

        # ...which frees a slot.
        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": "🔥"})
        assert r.status_code == 200, r.text

        # And the explicit DELETE works at the cap too.
        r = await bob.delete(f"/messages/{message_id}/reactions/{held[1]}")
        assert r.status_code == 200, r.text
        mine = [rn for rn in await _stored_reactions(message_id) if rn["user_id"] == bob_id]
        assert len(mine) == MAX_REACTIONS_PER_USER - 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_concurrent_distinct_reactions_cannot_exceed_the_per_user_cap():
    """The cap is part of the update's own filter, so it holds under concurrency.

    Ten different emoji fired at once: a count-then-push implementation would let every request
    read "0 so far" and all ten land. Exactly MAX_REACTIONS_PER_USER must succeed.
    """
    from app.domains.messages.services.messages_service import MAX_REACTIONS_PER_USER

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        responses = await asyncio.gather(
            *(
                bob.post(f"/messages/{message_id}/reactions", json={"emoji": emoji})
                for emoji in _DISTINCT[:10]
            )
        )
        statuses = sorted(r.status_code for r in responses)
        assert statuses.count(200) == MAX_REACTIONS_PER_USER, statuses
        assert statuses.count(409) == 10 - MAX_REACTIONS_PER_USER, statuses

        stored = await _stored_reactions(message_id)
        assert len(stored) == MAX_REACTIONS_PER_USER
        assert len({rn["emoji"] for rn in stored}) == MAX_REACTIONS_PER_USER
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_distinct_emoji_per_message_are_capped_but_existing_ones_stay_open():
    from app.domains.messages.services.messages_service import (
        MAX_DISTINCT_REACTIONS_PER_MESSAGE,
    )

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        present = _DISTINCT[:MAX_DISTINCT_REACTIONS_PER_MESSAGE]
        fresh = _DISTINCT[MAX_DISTINCT_REACTIONS_PER_MESSAGE]
        # Other members (ids that need not exist: the cap is a property of the document).
        await _seed_reactions(message_id, [(uuid.uuid4(), emoji) for emoji in present])

        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": fresh})
        assert r.status_code == 409, r.text
        assert r.json()["error_code"] == "REACTION_EMOJI_LIMIT_REACHED"

        # Joining an emoji that is already on the message does not widen the set.
        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": present[0]})
        assert r.status_code == 200, r.text
        assert len(await _stored_reactions(message_id)) == MAX_DISTINCT_REACTIONS_PER_MESSAGE + 1

        # Removal works on a message that is at the cap, by toggle and by DELETE.
        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": present[0]})
        assert r.status_code == 200, r.text
        r = await bob.post(f"/messages/{message_id}/reactions", json={"emoji": present[1]})
        assert r.status_code == 200, r.text
        r = await bob.delete(f"/messages/{message_id}/reactions/{present[1]}")
        assert r.status_code == 200, r.text
        assert not [rn for rn in await _stored_reactions(message_id) if rn["user_id"] == bob_id]
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_concurrent_members_cannot_exceed_the_distinct_emoji_cap():
    """Two members race for the last free emoji slot with different emoji: one wins."""
    from app.domains.messages.services.messages_service import (
        MAX_DISTINCT_REACTIONS_PER_MESSAGE,
    )

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        await _seed_reactions(
            message_id,
            [(uuid.uuid4(), e) for e in _DISTINCT[: MAX_DISTINCT_REACTIONS_PER_MESSAGE - 1]],
        )

        responses = await asyncio.gather(
            alice.post(f"/messages/{message_id}/reactions", json={"emoji": "🔥"}),
            bob.post(f"/messages/{message_id}/reactions", json={"emoji": "💀"}),
        )
        assert sorted(r.status_code for r in responses) == [200, 409], [r.text for r in responses]

        distinct = {rn["emoji"] for rn in await _stored_reactions(message_id)}
        assert len(distinct) == MAX_DISTINCT_REACTIONS_PER_MESSAGE
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_a_reaction_stored_before_the_stricter_validation_can_still_be_removed():
    """DELETE does not apply the add-time grammar, or old entries would be stranded forever."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        message_id = await _send_message(alice, chat_id)

        await _seed_reactions(message_id, [(bob_id, "é")])

        r = await bob.delete(f"/messages/{message_id}/reactions/%C3%A9")
        assert r.status_code == 200, r.text
        assert await _stored_reactions(message_id) == []
    finally:
        await alice.aclose()
        await bob.aclose()
