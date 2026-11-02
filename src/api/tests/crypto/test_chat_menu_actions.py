"""Chat-list context menu actions: pin, mark as unread, clear history (all per-user).

Every action here is one member's private arrangement of their own list. The tests that matter
most are therefore the isolation ones: whatever alice does, bob's view and bob's data must not move.
Talks to the running API over HTTP and, for the event tests, over a real WebSocket.
"""

import asyncio
import types
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings as app_settings
from app.domains.chats.services.chat_services import enrich_chats_with_mongo_data

from app.domains.crypto.reference.ratchet import SenderChain
from tests.crypto.test_channel_api import _channel_with, _post
from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_account_deletion import PASSWORD, _delete_account, _scalar
from tests.crypto.test_event_stream import _connect, _recv_type
from tests.crypto.test_identity_api import _register_user
from tests.crypto.test_migrations import _alembic
from tests.crypto.test_poll_control import Ctx
from tests.crypto.test_read_state import _mark_read, _private_chat, _read_state, _send
from tests.crypto.test_rotation_api import _publish_chain


async def _list(client) -> list[dict]:
    r = await client.get("/chats/?limit=100")
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def _row(client, chat_id) -> dict:
    return next(c for c in await _list(client) if c["id"] == str(chat_id))


async def _pin(client, chat_id, pinned=True):
    return await client.patch(f"/chats/{chat_id}/pin", json={"pinned": pinned})


async def _messages(client, chat_id) -> list[dict]:
    r = await client.get(f"/chats/{chat_id}/messages")
    assert r.status_code == 200, r.text
    return r.json()["data"]


@pytest.fixture
async def duo():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        yield alice, alice_id, bob, bob_id
    finally:
        await alice.aclose()
        await bob.aclose()


# --- pin ---


async def test_pin_and_unpin_are_idempotent_and_reported_in_list_and_detail(duo):
    alice, _, _, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)

    assert (await _row(alice, chat_id))["is_pinned"] is False

    r = await _pin(alice, chat_id)
    assert r.status_code == 200, r.text
    first = r.json()["data"]
    assert first["is_pinned"] is True and first["pinned_at"] and first["chat_id"] == str(chat_id)

    # Pinning again keeps the original timestamp: the chat must not jump to the top.
    again = (await _pin(alice, chat_id)).json()["data"]
    assert again["pinned_at"] == first["pinned_at"]

    row = await _row(alice, chat_id)
    assert row["is_pinned"] is True and row["pinned_at"] == first["pinned_at"]
    detail = (await alice.get(f"/chats/{chat_id}")).json()["data"]
    assert detail["is_pinned"] is True and detail["pinned_at"] == first["pinned_at"]

    r = await _pin(alice, chat_id, False)
    assert r.status_code == 200
    assert r.json()["data"]["is_pinned"] is False and r.json()["data"]["pinned_at"] is None
    assert (await _pin(alice, chat_id, False)).status_code == 200
    assert (await _row(alice, chat_id))["is_pinned"] is False


async def test_list_orders_pinned_first_newest_pin_first_then_by_activity(duo):
    alice, _, _, bob_id = duo
    carol, carol_id = await _register_user()
    dave, dave_id = await _register_user()
    try:
        c1 = await _private_chat(alice, bob_id)
        c2 = await _private_chat(alice, carol_id)
        c3 = await _private_chat(alice, dave_id)
        for c in (c1, c2, c3):
            await _send(alice, c, "hi")

        # Activity order, newest first: c3, c2, c1.
        assert [r["id"] for r in await _list(alice)] == [str(c3), str(c2), str(c1)]

        await _pin(alice, c1)
        await asyncio.sleep(0.05)
        await _pin(alice, c2)
        # Pinned: c2 (pinned last) then c1; then the unpinned c3.
        assert [r["id"] for r in await _list(alice)] == [str(c2), str(c1), str(c3)]

        # New activity in a pinned chat does not reorder the pins, and an unpinned chat's
        # activity cannot climb above them.
        await _send(alice, c3, "bump")
        await _send(alice, c1, "bump")
        assert [r["id"] for r in await _list(alice)] == [str(c2), str(c1), str(c3)]

        # Paging goes over the final order.
        r = await alice.get("/chats/?limit=1&offset=0")
        assert r.json()["data"][0]["id"] == str(c2)
    finally:
        await carol.aclose()
        await dave.aclose()


async def test_pin_limit_is_five_with_409_and_repin_is_exempt(duo):
    alice, _, _, _ = duo
    others, chats = [], []
    try:
        for _i in range(6):
            peer, peer_id = await _register_user()
            others.append(peer)
            chats.append(await _private_chat(alice, peer_id))

        for c in chats[:5]:
            assert (await _pin(alice, c)).status_code == 200

        r = await _pin(alice, chats[5])
        assert r.status_code == 409, r.text
        assert r.json()["error_code"] == "PINNED_CHAT_LIMIT"

        # Already pinned: idempotent even at the cap.
        assert (await _pin(alice, chats[0])).status_code == 200

        # Freeing a slot lets the sixth in.
        assert (await _pin(alice, chats[0], False)).status_code == 200
        assert (await _pin(alice, chats[5])).status_code == 200
        assert sum(r["is_pinned"] for r in await _list(alice)) == 5
    finally:
        for o in others:
            await o.aclose()


async def test_pin_is_per_user(duo):
    alice, _, bob, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    await _pin(alice, chat_id)
    assert (await _row(bob, chat_id))["is_pinned"] is False
    assert (await _row(alice, chat_id))["is_pinned"] is True


async def test_pin_limit_is_per_user_not_per_chat(duo):
    alice, _, bob, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    await _pin(alice, chat_id)
    assert (await _pin(bob, chat_id)).status_code == 200


# --- authorisation / validation ---


async def test_menu_actions_reject_non_members_and_unknown_chats(duo):
    alice, _, _, bob_id = duo
    mallory, _ = await _register_user()
    try:
        chat_id = await _private_chat(alice, bob_id)
        await _send(alice, chat_id, "secret")

        for r in (
            await _pin(mallory, chat_id),
            await mallory.patch(f"/chats/{chat_id}/unread", json={"marked": True}),
            await mallory.post(f"/chats/{chat_id}/clear-history"),
            await _pin(mallory, uuid.uuid4()),
        ):
            assert r.status_code == 403, r.text
            assert r.json()["error_code"] == "ACCESS_DENIED"
    finally:
        await mallory.aclose()


async def test_request_bodies_are_strict(duo):
    alice, _, _, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    assert (await alice.patch(f"/chats/{chat_id}/pin", json={"pinned": True, "x": 1})).status_code == 422
    assert (await alice.patch(f"/chats/{chat_id}/pin", json={})).status_code == 422
    assert (await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True, "x": 1})).status_code == 422
    assert (await alice.post(f"/chats/{chat_id}/clear-history", json={"x": 1})).status_code == 422
    # An empty object is accepted just like no body.
    assert (await alice.post(f"/chats/{chat_id}/clear-history", json={})).status_code == 200


# --- mark as unread ---


async def test_marked_unread_sets_without_touching_read_position_or_counts(duo):
    alice, alice_id, bob, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    m1 = await _send(bob, chat_id, "one")
    await _mark_read(alice, chat_id, m1)
    await _send(bob, chat_id, "two")

    before = await _row(alice, chat_id)
    assert before["marked_unread"] is False and before["unread_count"] == 1
    state_before = await _read_state(alice, chat_id)

    r = await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"chat_id": str(chat_id), "marked_unread": True}

    after = await _row(alice, chat_id)
    assert after["marked_unread"] is True and after["unread_count"] == 1
    assert (await alice.get(f"/chats/{chat_id}")).json()["data"]["marked_unread"] is True
    assert await _read_state(alice, chat_id) == state_before

    # Per-user: bob sees nothing, and idempotent both ways.
    assert (await _row(bob, chat_id))["marked_unread"] is False
    assert (await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})).status_code == 200
    r = await alice.patch(f"/chats/{chat_id}/unread", json={"marked": False})
    assert r.json()["data"]["marked_unread"] is False
    assert (await alice.patch(f"/chats/{chat_id}/unread", json={"marked": False})).status_code == 200
    assert (await _row(alice, chat_id))["marked_unread"] is False


async def test_reading_the_chat_clears_marked_unread_even_when_already_caught_up(duo):
    alice, _, bob, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    m1 = await _send(bob, chat_id, "one")
    await _mark_read(alice, chat_id, m1)  # fully caught up

    await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})
    assert (await _row(alice, chat_id))["marked_unread"] is True

    # Same position again: the read pointer does not advance, the flag must still clear.
    await _mark_read(alice, chat_id, m1)
    assert (await _row(alice, chat_id))["marked_unread"] is False

    # Reading by a different member never clears someone else's flag.
    await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})
    await _mark_read(bob, chat_id, m1)
    assert (await _row(alice, chat_id))["marked_unread"] is True


# --- clear history ---


async def test_clear_history_hides_for_me_only_and_new_messages_reappear(duo):
    alice, alice_id, bob, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    await _send(alice, chat_id, "a1")
    last_old = await _send(bob, chat_id, "b1")

    row = await _row(alice, chat_id)
    assert row["unread_count"] == 1 and row["last_message"] is not None
    await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})

    r = await alice.post(f"/chats/{chat_id}/clear-history")
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"chat_id": str(chat_id), "history_start_message_id": last_old}

    assert await _messages(alice, chat_id) == []
    row = await _row(alice, chat_id)
    assert row["last_message"] is None
    assert row["unread_count"] == 0
    assert row["marked_unread"] is False
    assert (await _read_state(alice, chat_id))[str(alice_id)] == last_old

    # Bob is entirely unaffected.
    assert len(await _messages(bob, chat_id)) == 2
    brow = await _row(bob, chat_id)
    assert brow["last_message"]["_id"] == last_old

    # New messages after the clear show up, count as unread, and become the preview.
    fresh = await _send(bob, chat_id, "b2")
    assert [m["_id"] for m in await _messages(alice, chat_id)] == [fresh]
    row = await _row(alice, chat_id)
    assert row["unread_count"] == 1 and row["last_message"]["_id"] == fresh
    assert len(await _messages(bob, chat_id)) == 3


async def test_clear_history_is_idempotent_and_empty_chat_is_a_noop(duo):
    alice, _, _, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)

    r = await alice.post(f"/chats/{chat_id}/clear-history")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["history_start_message_id"] is None

    m = await _send(alice, chat_id, "x")
    first = (await alice.post(f"/chats/{chat_id}/clear-history")).json()["data"]
    second = (await alice.post(f"/chats/{chat_id}/clear-history")).json()["data"]
    assert first["history_start_message_id"] == m == second["history_start_message_id"]
    assert await _messages(alice, chat_id) == []


async def test_clear_history_works_in_groups_and_channels_for_members():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        group = await _group_with(alice, bob_id)
        await _send(alice, group, "g1")
        r = await bob.post(f"/chats/{group}/clear-history")
        assert r.status_code == 200, r.text
        assert await _messages(bob, group) == []
        assert len(await _messages(alice, group)) == 1

        _, keys = await _publish_identity(alice, alice_id)
        channel = await _channel_with(alice, [bob_id])
        r = await alice.post("/messages/", json={
            "chat_id": str(channel), "channel_post": _post(keys, channel, alice_id),
        })
        assert r.status_code == 201, r.text
        assert (await bob.post(f"/chats/{channel}/clear-history")).status_code == 200
        assert await _messages(bob, channel) == []
        assert len(await _messages(alice, channel)) == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_clear_history_includes_control_messages_in_the_floor_and_hides_votes():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    device, keys = await _publish_identity(alice, alice_id)
    await _publish_identity(bob, bob_id)
    chat_id = await _group_with(alice, bob_id)
    try:
        assert (await alice.post(f"/crypto/chats/{chat_id}/enable")).status_code == 200
        chain_key, skid, ident = await _publish_chain(alice, chat_id, 1, alice_id, device, keys)
        ctx = Ctx(alice, alice_id, bob, bob_id, chat_id, SenderChain(chain_key), skid, ident,
                  device, keys)

        poll_id = await ctx.poll()
        vote = await ctx.vote(poll_id)
        assert vote.status_code == 201, vote.text
        vote_id = vote.json()["data"]["_id"]

        url = f"/messages/{chat_id}/polls/{poll_id}/votes"
        assert len((await bob.get(url)).json()["data"]) == 1

        r = await bob.post(f"/chats/{chat_id}/clear-history")
        # The newest document is the vote, not the poll.
        assert r.json()["data"]["history_start_message_id"] == vote_id
        assert (await bob.get(url)).json()["data"] == []
        assert await _messages(bob, chat_id) == []

        # Alice still sees the poll and the vote.
        assert len((await alice.get(url)).json()["data"]) == 1
        assert [m["_id"] for m in await _messages(alice, chat_id)] == [poll_id]

        # A control message after the clear is not unread and not a preview.
        row = await _row(bob, chat_id)
        assert row["unread_count"] == 0 and row["last_message"] is None
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_enrichment_applies_the_history_floor_per_chat(duo):
    """Two chats in one list, only one cleared: the floor must not leak across chats."""
    alice, _, bob, bob_id = duo
    carol, carol_id = await _register_user()
    try:
        c1 = await _private_chat(alice, bob_id)
        c2 = await _private_chat(alice, carol_id)
        await _send(bob, c1, "b")
        m2 = await _send(carol, c2, "c")

        await alice.post(f"/chats/{c1}/clear-history")

        r1, r2 = await _row(alice, c1), await _row(alice, c2)
        assert r1["last_message"] is None and r1["unread_count"] == 0
        assert r2["last_message"]["_id"] == m2 and r2["unread_count"] == 1
    finally:
        await carol.aclose()


async def test_attachment_authorisation_is_unchanged_by_the_floor(duo):
    """The floor hides history; it must not turn a member's access to the chat into a 403."""
    alice, _, _, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    await _send(alice, chat_id, "x")
    await alice.post(f"/chats/{chat_id}/clear-history")
    r = await alice.get(f"/files/attachments/{chat_id}/{uuid.uuid4().hex}")
    assert r.status_code != 403, r.text


# --- delete/leave behaviour the client menu depends on ---


async def test_leave_and_delete_matrix():
    owner, owner_id = await _register_user()
    member, member_id = await _register_user()
    try:
        private = await _private_chat(owner, member_id)
        r = await owner.post(f"/chats/{private}/leave")
        assert (r.status_code, r.json()["error_code"]) == (400, "INVALID_CHAT_TYPE")
        r = await owner.delete(f"/chats/{private}")
        assert (r.status_code, r.json()["error_code"]) == (400, "INVALID_CHAT_TYPE")

        for make in (_group_with, _channel_with):
            chat = await make(owner, member_id) if make is _group_with else await make(owner, [member_id])
            r = await owner.post(f"/chats/{chat}/leave")
            assert (r.status_code, r.json()["error_code"]) == (400, "OWNER_CANNOT_LEAVE")
            r = await member.delete(f"/chats/{chat}")
            assert (r.status_code, r.json()["error_code"]) == (403, "ACCESS_DENIED")
            assert (await member.post(f"/chats/{chat}/leave")).status_code == 200
            assert (await owner.delete(f"/chats/{chat}")).status_code == 200
    finally:
        await owner.aclose()
        await member.aclose()


# --- WebSocket: acting user's devices only ---


async def test_menu_events_reach_only_the_acting_users_sockets(duo):
    alice, _, bob, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    m1 = await _send(bob, chat_id, "hi")

    async with _connect(alice) as alice_device_2, _connect(bob) as bob_ws:
        r = await _pin(alice, chat_id)
        pinned_at = r.json()["data"]["pinned_at"]
        ev = await _recv_type(alice_device_2, "chat_updated")
        assert ev["chat_id"] == str(chat_id)
        assert ev["payload"]["pinned"] is True
        assert ev["payload"]["pinned_at"]
        assert ev["stream_id"], "durable"
        assert pinned_at

        await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})
        ev = await _recv_type(alice_device_2, "chat_updated")
        assert ev["payload"] == {"marked_unread": True}

        # Reading from any device clears the flag and tells the user's sockets.
        await _mark_read(alice, chat_id, m1)
        ev = await _recv_type(alice_device_2, "chat_updated")
        assert ev["payload"] == {"marked_unread": False}

        await alice.post(f"/chats/{chat_id}/clear-history")
        ev = await _recv_type(alice_device_2, "chat_updated")
        assert ev["payload"] == {"history_cleared": True, "floor": m1}

        # Idempotent repeat of an unchanged pin publishes nothing new.
        await _pin(alice, chat_id)  # already pinned
        with pytest.raises(asyncio.TimeoutError):
            await _recv_type(alice_device_2, "chat_updated", timeout=1.0)

        # Bob (the other member) never got any of it.
        with pytest.raises(asyncio.TimeoutError):
            await _recv_type(bob_ws, "chat_updated", timeout=1.0)


# --- review follow-ups ---


async def test_my_role_is_the_callers_own_role_everywhere():
    owner, owner_id = await _register_user()
    admin, admin_id = await _register_user()
    member, member_id = await _register_user()
    try:
        r = await owner.post("/chats/group", json={
            "title": "Roles", "participant_ids": [str(admin_id), str(member_id)],
        })
        assert r.status_code == 200, r.text
        # The creation response is the creator's own view.
        assert r.json()["data"]["my_role"] == "owner"
        chat_id = uuid.UUID(r.json()["data"]["id"])
        r = await owner.post(f"/chats/{chat_id}/change-role",
                             json={"user_id": str(admin_id), "role": "admin"})
        assert r.status_code == 200, r.text

        for client, expected in ((owner, "owner"), (admin, "admin"), (member, "member")):
            assert (await _row(client, chat_id))["my_role"] == expected
            detail = (await client.get(f"/chats/{chat_id}")).json()["data"]
            assert detail["my_role"] == expected

        # Private chat: both sides are plain members, including when reopened via POST.
        private = await _private_chat(owner, member_id)
        assert (await _row(owner, private))["my_role"] == "member"
        r = await member.post("/chats/private", json={"target_user_id": str(owner_id)})
        assert r.json()["data"]["my_role"] == "member"
        assert (await owner.get(f"/chats/{private}")).json()["data"]["my_role"] == "member"

        # Channel creation response carries the creator's role.
        r = await owner.post("/chats/channel", json={"title": "C", "subscriber_ids": [str(member_id)]})
        assert r.json()["data"]["my_role"] == "owner"
        assert (await _row(member, uuid.UUID(r.json()["data"]["id"])))["my_role"] == "member"
    finally:
        for c in (owner, admin, member):
            await c.aclose()


async def test_demoted_owner_cannot_delete_and_transfer_vs_delete_race_has_one_winner():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        # Deterministic: after the hand-over the old owner is refused.
        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(f"/chats/{chat_id}/transfer-ownership", json={"user_id": str(bob_id)})
        assert r.status_code == 200, r.text
        r = await alice.delete(f"/chats/{chat_id}")
        assert (r.status_code, r.json()["error_code"]) == (403, "ACCESS_DENIED")
        assert (await bob.get(f"/chats/{chat_id}")).status_code == 200

        # Racing: whichever takes the chat lock first wins, and the outcome is consistent.
        for _ in range(6):
            chat_id = await _group_with(alice, bob_id)
            await _send(alice, chat_id, "x")
            deleted, transferred = await asyncio.gather(
                alice.delete(f"/chats/{chat_id}"),
                alice.post(f"/chats/{chat_id}/transfer-ownership", json={"user_id": str(bob_id)}),
            )
            assert (deleted.status_code == 200) != (transferred.status_code == 200), (
                deleted.text, transferred.text)
            if deleted.status_code == 200:
                assert (await bob.get(f"/chats/{chat_id}")).status_code == 403
            else:
                assert deleted.status_code == 403, deleted.text
                detail = (await bob.get(f"/chats/{chat_id}")).json()["data"]
                assert detail["my_role"] == "owner"
                assert len(await _messages(bob, chat_id)) == 1, "a refused delete must purge nothing"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_concurrent_pins_cannot_overshoot_the_limit(duo):
    alice, _, _, _ = duo
    peers, chats = [], []
    try:
        for _i in range(7):
            peer, peer_id = await _register_user()
            peers.append(peer)
            chats.append(await _private_chat(alice, peer_id))
        for c in chats[:4]:
            assert (await _pin(alice, c)).status_code == 200

        results = await asyncio.gather(*(_pin(alice, c) for c in chats[4:]))
        codes = sorted(r.status_code for r in results)
        assert codes == [200, 409, 409], codes
        assert sum(r["is_pinned"] for r in await _list(alice)) == 5
    finally:
        for p in peers:
            await p.aclose()


async def test_pinned_chats_stay_on_the_first_pages_across_limit_offset(duo):
    alice, _, _, _ = duo
    peers, chats = [], []
    try:
        for _i in range(4):
            peer, peer_id = await _register_user()
            peers.append(peer)
            chats.append(await _private_chat(alice, peer_id))
            await _send(alice, chats[-1], "m")
        # chats[0] is the oldest by activity; pin it and the second oldest.
        await _pin(alice, chats[0])
        await asyncio.sleep(0.05)
        await _pin(alice, chats[1])

        page1 = (await alice.get("/chats/?limit=2&offset=0")).json()
        page2 = (await alice.get("/chats/?limit=2&offset=2")).json()
        assert [c["id"] for c in page1["data"]] == [str(chats[1]), str(chats[0])]
        assert [c["id"] for c in page2["data"]] == [str(chats[3]), str(chats[2])]
        assert page1["meta"]["has_more"] is True and page2["meta"]["has_more"] is False
        assert page1["meta"]["total"] == 4
    finally:
        for p in peers:
            await p.aclose()


async def test_floor_applies_to_before_id_pagination_and_pinned_messages(duo):
    alice, _, bob, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)
    m1 = await _send(alice, chat_id, "m1")
    m2 = await _send(bob, chat_id, "m2")
    assert (await alice.post(f"/messages/{m1}/pin")).status_code == 200
    await alice.post(f"/chats/{chat_id}/clear-history")
    m3 = await _send(alice, chat_id, "m3")
    m4 = await _send(bob, chat_id, "m4")
    assert (await alice.post(f"/messages/{m3}/pin")).status_code == 200

    # A `before_id` pointing past the floor cannot page back through it.
    r = await alice.get(f"/chats/{chat_id}/messages?before_id={m4}")
    assert [m["_id"] for m in r.json()["data"]] == [m3]
    r = await alice.get(f"/chats/{chat_id}/messages?before_id={m3}")
    assert r.json()["data"] == []
    r = await alice.get(f"/chats/{chat_id}/messages?before_id={m2}")
    assert r.json()["data"] == []

    pinned = (await alice.get(f"/chats/{chat_id}/pinned-messages")).json()["data"]
    assert [m["_id"] for m in pinned] == [m3]
    bob_pinned = (await bob.get(f"/chats/{chat_id}/pinned-messages")).json()["data"]
    assert {m["_id"] for m in bob_pinned} == {m1, m3}


async def test_account_deletion_resets_pin_and_unread_on_frozen_private_chats():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _private_chat(alice, bob_id)
        await _pin(alice, chat_id)
        await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})
        await _pin(bob, chat_id)
        assert (await _delete_account(alice, PASSWORD)).status_code == 200

        row = await _scalar(
            "SELECT pinned_at IS NULL AND marked_unread = false FROM chat_participants "
            "WHERE chat_id = :c AND user_id = :u", c=chat_id, u=alice_id)
        assert row is True
        # The surviving peer keeps their own arrangement.
        assert (await _row(bob, chat_id))["is_pinned"] is True
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_menu_routes_are_rate_limited_per_user(duo):
    alice, _, _, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)

    # pin, unread and clear-history share one budget of 60/min.
    statuses = [(await _pin(alice, chat_id, i % 2 == 0)).status_code for i in range(60)]
    assert set(statuses) == {200}
    assert (await _pin(alice, chat_id)).status_code == 429
    assert (await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})).status_code == 429
    assert (await alice.post(f"/chats/{chat_id}/clear-history")).status_code == 429
    # Another user is unaffected.
    other, _ = await _register_user()
    try:
        assert (await other.patch(f"/chats/{chat_id}/unread", json={"marked": True})).status_code == 403
    finally:
        await other.aclose()


async def test_delete_chat_is_rate_limited_per_user():
    alice, _ = await _register_user()
    try:
        codes = [(await alice.delete(f"/chats/{uuid.uuid4()}")).status_code for _ in range(21)]
        assert codes[:20] == [403] * 20 and codes[20] == 429
    finally:
        await alice.aclose()


class _FakeCollection:
    def __init__(self):
        self.queried_chats = []

    async def find_one(self, query, **kwargs):
        self.queried_chats.append(query["chat_id"])
        return None

    async def count_documents(self, query):
        return 0


async def test_malformed_floor_fails_closed():
    good, bad = uuid.uuid4(), uuid.uuid4()

    def chat(cid, floor):
        return types.SimpleNamespace(
            id=cid, title="t", avatar_url=None, chat_type="group", participants=[],
            created_at=None, updated_at=None, history_start_message_id=floor,
            last_read_message_id=None)

    coll = _FakeCollection()
    out = await enrich_chats_with_mongo_data(
        {"messages": coll}, uuid.uuid4(), [chat(good, "a" * 24), chat(bad, "not-an-objectid")]
    )
    assert coll.queried_chats == [good], "the malformed-floor chat must not be queried"
    assert all(c["last_message"] is None and c["unread_count"] == 0 for c in out)


async def test_read_frame_does_not_write_when_the_flag_is_not_set(duo):
    """Hot path: `clear_marked_unread` is a SELECT only unless the flag is actually set."""
    alice, alice_id, _, bob_id = duo
    chat_id = await _private_chat(alice, bob_id)

    class Spy:
        def __init__(self, real):
            self.real, self.commits, self.executed = real, 0, 0

        async def scalar(self, *a, **k):
            return await self.real.scalar(*a, **k)

        async def execute(self, *a, **k):
            self.executed += 1
            return await self.real.execute(*a, **k)

        async def commit(self):
            self.commits += 1
            await self.real.commit()

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.domains.chats.services.chat_services import clear_marked_unread

    engine = create_async_engine(app_settings.DATABASE_URL)
    try:
        async with async_sessionmaker(bind=engine, expire_on_commit=False)() as db:
            spy = Spy(db)
            assert await clear_marked_unread(spy, chat_id, alice_id) is False
            assert (spy.commits, spy.executed) == (0, 0)

            await alice.patch(f"/chats/{chat_id}/unread", json={"marked": True})
            assert await clear_marked_unread(spy, chat_id, alice_id) is True
            assert spy.commits == 1
    finally:
        await engine.dispose()


async def test_chat_menu_migration_cycles_and_backfills_existing_rows():
    scratch = f"migtest_{uuid.uuid4().hex[:12]}"
    base = make_url(app_settings.DATABASE_URL)
    admin = create_async_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    scratch_url = base.set(database=scratch).render_as_string(hide_password=False)
    before, this = "f6a4b8d0e235", "a7c3e9f1b2d4"
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{scratch}"'))
        run = lambda *a: asyncio.to_thread(_alembic, scratch_url, *a)  # noqa: E731

        r = await run("upgrade", before)
        assert r.returncode == 0, r.stderr[-2000:]

        user_id, chat_id = uuid.uuid4(), uuid.uuid4()
        engine = create_async_engine(scratch_url)
        async with engine.begin() as conn:
            await conn.execute(text(
                "INSERT INTO users (id, full_name, username, phone_number, hashed_password, email, "
                "is_verified, public_key, encrypted_private_key, is_active) VALUES "
                "(:u, 'n', :name, '+380500000001', 'h', 'm2@example.com', true, 'k', 'k', true)"
            ), {"u": user_id, "name": f"user_{uuid.uuid4().hex[:8]}"})
            await conn.execute(text("INSERT INTO chats (id, chat_type) VALUES (:c, 'GROUP')"), {"c": chat_id})
            await conn.execute(text(
                "INSERT INTO chat_participants (id, chat_id, user_id, role) VALUES (:i, :c, :u, 'MEMBER')"
            ), {"i": uuid.uuid4(), "c": chat_id, "u": user_id})

        for args in (("upgrade", this), ("downgrade", before), ("upgrade", "head")):
            r = await run(*args)
            assert r.returncode == 0, f"{args}: {(r.stdout + r.stderr)[-2000:]}"

        async with engine.connect() as conn:
            row = (await conn.execute(text(
                "SELECT pinned_at, marked_unread FROM chat_participants WHERE chat_id = :c"
            ), {"c": chat_id})).one()
        assert row.pinned_at is None and row.marked_unread is False
        await engine.dispose()

        r = await run("check")
        assert r.returncode == 0, (r.stdout + r.stderr)[-2000:]
    finally:
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)'))
        await admin.dispose()
