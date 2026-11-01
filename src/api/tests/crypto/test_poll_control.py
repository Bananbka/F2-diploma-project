"""Poll control messages: the two server-visible fields and everything the server does with them.

A vote or close marker is an ordinary sealed message that carries `is_control` and
`poll_message_id`. It goes through the normal send path; the server only keeps it out of unread
counts, previews and the history listing, and serves it from a dedicated votes route.
"""
import uuid

import pytest
from redis.asyncio import Redis

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.domains.crypto.reference.ratchet import SenderChain
from app.domains.messages.routes.messages_routes import (
    MESSAGE_WRITE_LIMIT,
    MESSAGE_WRITE_WINDOW,
    POLL_VOTES_READ_LIMIT,
    POLL_VOTES_READ_WINDOW,
)
from app.domains.messages.services.messages_service import CONTROL_MAX_PER_POLL_PER_SENDER
from app.infrastructure.mongo import connect_to_mongo, ensure_indexes, mongo_client

from tests.crypto.test_channel_api import _channel_with, _post
from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_event_stream import _connect, _recv_type
from tests.crypto.test_identity_api import _register_user
from tests.crypto.test_read_state import _mark_read
from tests.crypto.test_rotation_api import _publish_chain, _seal


class Ctx:
    """An encrypted group (alice owner, bob member) with alice's chain published."""

    def __init__(self, alice, alice_id, bob, bob_id, chat_id, chain, skid, ident, device, keys):
        self.alice, self.alice_id, self.bob, self.bob_id = alice, alice_id, bob, bob_id
        self.chat_id, self.chain, self.skid, self.ident = chat_id, chain, skid, ident
        self.device, self.keys, self.epoch = device, keys, 1

    def env(self, body=b"x"):
        return _seal(self.chain, self.chat_id, self.epoch, self.alice_id, self.skid, self.ident, body)

    async def send(self, **extra):
        body = {"chat_id": str(self.chat_id), "envelope": self.env(), **extra}
        return await self.alice.post("/messages/", json=body)

    async def poll(self):
        r = await self.send()
        assert r.status_code == 201, r.text
        return r.json()["data"]["_id"]

    async def vote(self, poll_id, **extra):
        return await self.send(is_control=True, poll_message_id=poll_id, **extra)


@pytest.fixture
async def ctx():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    device, keys = await _publish_identity(alice, alice_id)
    await _publish_identity(bob, bob_id)
    chat_id = await _group_with(alice, bob_id)
    r = await alice.post(f"/crypto/chats/{chat_id}/enable")
    assert r.status_code == 200, r.text
    chain_key, skid, ident = await _publish_chain(alice, chat_id, 1, alice_id, device, keys)
    try:
        yield Ctx(alice, alice_id, bob, bob_id, chat_id, SenderChain(chain_key), skid, ident,
                  device, keys)
    finally:
        await alice.aclose()
        await bob.aclose()


async def _chat_row(client, chat_id):
    r = await client.get("/chats/")
    assert r.status_code == 200, r.text
    return next(c for c in r.json()["data"] if c["id"] == str(chat_id))


# --- validation matrix ---

async def test_control_requires_poll_message_id(ctx):
    r = await ctx.send(is_control=True)
    assert r.status_code == 422


async def test_poll_message_id_forbidden_without_control(ctx):
    poll_id = await ctx.poll()
    r = await ctx.send(poll_message_id=poll_id)
    assert r.status_code == 422
    r = await ctx.send(is_control=False, poll_message_id=poll_id)
    assert r.status_code == 422


@pytest.mark.parametrize("bad", ["", "xyz", "G" * 24, "A" * 24, "a" * 23, "a" * 25])
async def test_poll_message_id_must_be_24_lowercase_hex(ctx, bad):
    r = await ctx.vote(bad)
    assert r.status_code == 422


async def test_control_cannot_carry_reply_or_forward(ctx):
    poll_id = await ctx.poll()
    r = await ctx.vote(poll_id, reply_to_message_id=poll_id)
    assert r.status_code == 422


async def test_valid_vote_is_stored_and_echoed(ctx):
    poll_id = await ctx.poll()
    r = await ctx.vote(poll_id)
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data["is_control"] is True
    assert data["poll_message_id"] == poll_id
    assert data["content_format"] == "sender_keys_v1"


async def test_normal_messages_default_to_not_control(ctx):
    poll_id = await ctx.poll()
    r = await ctx.bob.get(f"/chats/{ctx.chat_id}/messages")
    msg = r.json()["data"][0]
    assert msg["_id"] == poll_id
    assert msg["is_control"] is False
    assert msg["poll_message_id"] is None


async def test_unknown_poll_is_404(ctx):
    r = await ctx.vote("a" * 24)
    assert r.status_code == 404
    assert r.json()["error_code"] == "POLL_NOT_FOUND"


async def test_cross_chat_poll_id_is_rejected_identically(ctx):
    # A real message, in a chat alice belongs to, but not this one.
    other_chat = await _group_with(ctx.alice, ctx.bob_id, title="Other")
    r = await ctx.alice.post(f"/crypto/chats/{other_chat}/enable")
    assert r.status_code == 200, r.text
    key, skid, ident = await _publish_chain(
        ctx.alice, other_chat, 1, ctx.alice_id, ctx.device, ctx.keys
    )
    foreign = _seal(SenderChain(key), other_chat, 1, ctx.alice_id, skid, ident)
    r = await ctx.alice.post("/messages/", json={"chat_id": str(other_chat), "envelope": foreign})
    assert r.status_code == 201, r.text
    foreign_id = r.json()["data"]["_id"]

    r = await ctx.vote(foreign_id)
    assert r.status_code == 404
    assert r.json()["error_code"] == "POLL_NOT_FOUND"


async def test_non_member_cannot_send_or_list(ctx):
    outsider, _ = await _register_user()
    try:
        poll_id = await ctx.poll()
        r = await outsider.post("/messages/", json={
            "chat_id": str(ctx.chat_id), "envelope": ctx.env(),
            "is_control": True, "poll_message_id": poll_id,
        })
        assert r.status_code == 403
        r = await outsider.get(f"/messages/{ctx.chat_id}/polls/{poll_id}/votes")
        assert r.status_code == 403
    finally:
        await outsider.aclose()


async def test_control_cannot_target_control(ctx):
    poll_id = await ctx.poll()
    r = await ctx.vote(poll_id)
    vote_id = r.json()["data"]["_id"]
    r = await ctx.vote(vote_id)
    assert r.status_code == 422
    assert r.json()["error_code"] == "POLL_TARGET_IS_CONTROL"


async def test_channel_cannot_carry_control(ctx):
    channel_id = await _channel_with(ctx.alice, [ctx.bob_id])
    r = await ctx.alice.post("/messages/", json={
        "chat_id": str(channel_id), "channel_post": _post(ctx.keys, channel_id, ctx.alice_id),
        "is_control": True, "poll_message_id": "a" * 24,
    })
    assert r.status_code == 422
    assert r.json()["error_code"] == "CONTROL_MESSAGE_NOT_ALLOWED"


async def test_legacy_chat_cannot_carry_control(ctx):
    legacy = await _group_with(ctx.alice, ctx.bob_id, title="Legacy")
    r = await ctx.alice.post("/messages/", json={"chat_id": str(legacy), "encrypted_content": "hi"})
    legacy_msg = r.json()["data"]["_id"]
    r = await ctx.alice.post("/messages/", json={
        "chat_id": str(legacy), "encrypted_content": "vote",
        "is_control": True, "poll_message_id": legacy_msg,
    })
    assert r.status_code == 422
    assert r.json()["error_code"] == "CONTROL_MESSAGE_NOT_ALLOWED"


async def test_control_goes_through_the_normal_envelope_checks(ctx):
    poll_id = await ctx.poll()
    stale = _seal(ctx.chain, ctx.chat_id, 7, ctx.alice_id, ctx.skid, ctx.ident)
    r = await ctx.alice.post("/messages/", json={
        "chat_id": str(ctx.chat_id), "envelope": stale,
        "is_control": True, "poll_message_id": poll_id,
    })
    assert r.status_code == 409
    assert r.json()["error_code"] == "EPOCH_STALE"

    # Another member's signature (bob has no sender key) is refused as well.
    r = await ctx.bob.post("/messages/", json={
        "chat_id": str(ctx.chat_id), "envelope": ctx.env(),
        "is_control": True, "poll_message_id": poll_id,
    })
    assert r.status_code == 403
    assert r.json()["error_code"] == "SENDER_KEY_NOT_YOURS"


# --- idempotency, rate limit ---

async def test_idempotent_replay_returns_same_vote(ctx):
    poll_id = await ctx.poll()
    cid = str(uuid.uuid4())
    first = await ctx.vote(poll_id, client_message_id=cid)
    assert first.status_code == 201, first.text
    again = await ctx.vote(poll_id, client_message_id=cid)
    assert again.status_code == 200, again.text
    assert again.json()["data"]["_id"] == first.json()["data"]["_id"]

    # Same id reused for a different poll is a different request.
    other = await ctx.poll()
    reused = await ctx.vote(other, client_message_id=cid)
    assert reused.status_code == 409
    assert reused.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"

    # ...and so is reusing it for an ordinary message.
    reused = await ctx.send(client_message_id=cid)
    assert reused.status_code == 409


async def test_control_messages_count_against_the_send_rate_limit(ctx):
    poll_id = await ctx.poll()
    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    original = settings.RATE_LIMIT_ENABLED
    settings.RATE_LIMIT_ENABLED = True
    try:
        # Exhaust the budget (earlier sends already used a few; overshoot is expected).
        for _ in range(MESSAGE_WRITE_LIMIT):
            try:
                await enforce_rate_limit(
                    redis, scope="message-send", identifier=str(ctx.alice_id),
                    limit=MESSAGE_WRITE_LIMIT, window_seconds=MESSAGE_WRITE_WINDOW,
                )
            except AppException:
                break
        r = await ctx.vote(poll_id)
        assert r.status_code == 429
    finally:
        settings.RATE_LIMIT_ENABLED = original
        await redis.aclose()


# --- unread / preview / listing ---

async def test_control_is_not_unread_and_not_last_message(ctx):
    poll_id = await ctx.poll()
    for _ in range(3):
        assert (await ctx.vote(poll_id)).status_code == 201

    row = await _chat_row(ctx.bob, ctx.chat_id)
    assert row["unread_count"] == 1
    assert row["last_message"]["_id"] == poll_id


async def test_control_newer_than_last_read_does_not_make_chat_unread(ctx):
    poll_id = await ctx.poll()
    await _mark_read(ctx.bob, ctx.chat_id, poll_id)
    assert (await _chat_row(ctx.bob, ctx.chat_id))["unread_count"] == 0

    await ctx.vote(poll_id)
    await ctx.vote(poll_id)
    assert (await _chat_row(ctx.bob, ctx.chat_id))["unread_count"] == 0


async def test_chat_with_only_control_messages_has_no_preview(ctx):
    """A control message alone (poll deleted from the list view's perspective) is no preview."""
    poll_id = await ctx.poll()
    await ctx.vote(poll_id)
    # Remove the poll's visible document without cascading, leaving an orphan vote.
    await connect_to_mongo()
    from bson import ObjectId
    await mongo_client.db["messages"].delete_one({"_id": ObjectId(poll_id)})

    row = await _chat_row(ctx.bob, ctx.chat_id)
    assert row["last_message"] is None
    assert row["unread_count"] == 0


async def test_vote_does_not_reorder_chats(ctx):
    other = await _group_with(ctx.alice, ctx.bob_id, title="Newer")
    poll_id = await ctx.poll()           # the poll itself is a normal message and bumps the chat
    await ctx.alice.post(f"/crypto/chats/{other}/enable")
    r = await ctx.alice.get("/chats/")
    before = next(c for c in r.json()["data"] if c["id"] == str(ctx.chat_id))["updated_at"]

    assert (await ctx.vote(poll_id)).status_code == 201

    r = await ctx.alice.get("/chats/")
    after = next(c for c in r.json()["data"] if c["id"] == str(ctx.chat_id))["updated_at"]
    assert after == before


async def test_normal_listing_excludes_control(ctx):
    poll_id = await ctx.poll()
    await ctx.vote(poll_id)
    r = await ctx.bob.get(f"/chats/{ctx.chat_id}/messages")
    assert [m["_id"] for m in r.json()["data"]] == [poll_id]


# --- votes route ---

async def test_votes_listing_newest_first_with_pagination(ctx):
    poll_id = await ctx.poll()
    other_poll = await ctx.poll()
    ids = [(await ctx.vote(poll_id)).json()["data"]["_id"] for _ in range(5)]
    await ctx.vote(other_poll)

    url = f"/messages/{ctx.chat_id}/polls/{poll_id}/votes"
    r = await ctx.bob.get(url)
    assert r.status_code == 200, r.text
    got = [m["_id"] for m in r.json()["data"]]
    assert got == list(reversed(ids))
    assert all(m["is_control"] and m["poll_message_id"] == poll_id for m in r.json()["data"])

    r = await ctx.bob.get(url, params={"limit": 2})
    page1 = [m["_id"] for m in r.json()["data"]]
    assert page1 == list(reversed(ids))[:2]
    r = await ctx.bob.get(url, params={"limit": 2, "before": page1[-1]})
    page2 = [m["_id"] for m in r.json()["data"]]
    assert page2 == list(reversed(ids))[2:4]

    assert (await ctx.bob.get(url, params={"limit": 0})).status_code == 422
    assert (await ctx.bob.get(url, params={"limit": 201})).status_code == 422
    assert (await ctx.bob.get(url, params={"before": "nope"})).status_code == 400
    assert (await ctx.bob.get(f"/messages/{ctx.chat_id}/polls/nope/votes")).status_code == 400


async def test_votes_listing_respects_history_floor():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        device, keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)
        await _publish_identity(carol, carol_id)
        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")
        key, skid, ident = await _publish_chain(alice, chat_id, 1, alice_id, device, keys)
        chain = SenderChain(key)

        def body(epoch, **extra):
            return {"chat_id": str(chat_id), **extra,
                    "envelope": _seal(chain if epoch == 1 else chain2, chat_id, epoch, alice_id,
                                      skid if epoch == 1 else skid2,
                                      ident if epoch == 1 else ident2)}

        r = await alice.post("/messages/", json=body(1))
        poll_id = r.json()["data"]["_id"]
        r = await alice.post("/messages/", json=body(1, is_control=True, poll_message_id=poll_id))
        old_vote = r.json()["data"]["_id"]

        r = await alice.post(f"/chats/{chat_id}/add-participants",
                             json={"user_ids": [str(carol_id)]})
        assert r.status_code == 200, r.text

        key2, skid2, ident2 = await _publish_chain(alice, chat_id, 2, alice_id, device, keys)
        chain2 = SenderChain(key2)
        r = await alice.post("/messages/", json=body(2, is_control=True, poll_message_id=poll_id))
        assert r.status_code == 201, r.text
        new_vote = r.json()["data"]["_id"]

        url = f"/messages/{chat_id}/polls/{poll_id}/votes"
        r = await carol.get(url)
        assert [m["_id"] for m in r.json()["data"]] == [new_vote]
        r = await alice.get(url)
        assert [m["_id"] for m in r.json()["data"]] == [new_vote, old_vote]
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


# --- edits, reactions ---

async def test_control_messages_cannot_be_edited_or_reacted_to(ctx):
    poll_id = await ctx.poll()
    vote_id = (await ctx.vote(poll_id)).json()["data"]["_id"]

    r = await ctx.alice.put(f"/messages/{vote_id}", json={"envelope": ctx.env()})
    assert r.status_code == 409
    assert r.json()["error_code"] == "CONTROL_MESSAGE_NOT_EDITABLE"

    r = await ctx.bob.post(f"/messages/{vote_id}/reactions", json={"emoji": "👍"})
    assert r.status_code == 409


async def test_edit_cannot_smuggle_control_fields(ctx):
    poll_id = await ctx.poll()
    r = await ctx.alice.put(
        f"/messages/{poll_id}",
        json={"envelope": ctx.env(), "is_control": True, "poll_message_id": poll_id},
    )
    assert r.status_code == 422

    r = await ctx.alice.put(f"/messages/{poll_id}", json={"envelope": ctx.env()})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["is_control"] is False
    assert r.json()["data"]["poll_message_id"] is None


# --- websocket ---

async def test_ws_event_carries_the_fields(ctx):
    poll_id = await ctx.poll()
    async with _connect(ctx.bob) as ws:
        r = await ctx.vote(poll_id)
        assert r.status_code == 201, r.text
        event = await _recv_type(ws, "new_message")
        assert event["payload"]["is_control"] is True
        assert event["payload"]["poll_message_id"] == poll_id
        assert event["payload"]["_id"] == r.json()["data"]["_id"]


# --- cascade ---

async def test_deleting_a_poll_removes_its_votes_only(ctx):
    poll_id = await ctx.poll()
    other_poll = await ctx.poll()
    await ctx.vote(poll_id)
    await ctx.vote(poll_id)
    keep = (await ctx.vote(other_poll)).json()["data"]["_id"]

    r = await ctx.alice.delete(f"/messages/{poll_id}")
    assert r.status_code == 200, r.text

    r = await ctx.bob.get(f"/messages/{ctx.chat_id}/polls/{poll_id}/votes")
    assert r.json()["data"] == []
    r = await ctx.bob.get(f"/messages/{ctx.chat_id}/polls/{other_poll}/votes")
    assert [m["_id"] for m in r.json()["data"]] == [keep]


# --- index ---

async def test_poll_votes_index_exists():
    await connect_to_mongo()
    await ensure_indexes()
    info = await mongo_client.db["messages"].index_information()
    index = info["ix_chat_poll_id"]
    assert [k for k, _ in index["key"]] == ["chat_id", "poll_message_id", "_id"]
    assert index["partialFilterExpression"] == {"is_control": True}


# --- abuse limits, deletion, replay mismatch ---

async def test_oversized_control_message_is_refused(ctx):
    poll_id = await ctx.poll()
    big = _seal(ctx.chain, ctx.chat_id, 1, ctx.alice_id, ctx.skid, ctx.ident, b"v" * 4000)
    r = await ctx.alice.post("/messages/", json={
        "chat_id": str(ctx.chat_id), "envelope": big,
        "is_control": True, "poll_message_id": poll_id,
    })
    assert r.status_code == 422
    assert r.json()["error_code"] == "CONTROL_MESSAGE_TOO_LARGE"

    # The same payload as an ordinary message is fine: the cap is for control messages only.
    r = await ctx.alice.post("/messages/", json={"chat_id": str(ctx.chat_id), "envelope": big})
    assert r.status_code == 201, r.text


async def test_control_messages_per_poll_per_sender_are_capped(ctx):
    poll_id = await ctx.poll()
    other_poll = await ctx.poll()
    for _ in range(CONTROL_MAX_PER_POLL_PER_SENDER):
        assert (await ctx.vote(poll_id)).status_code == 201

    r = await ctx.vote(poll_id)
    assert r.status_code == 409
    assert r.json()["error_code"] == "CONTROL_MESSAGE_LIMIT"

    # Per poll: another poll is unaffected.
    assert (await ctx.vote(other_poll)).status_code == 201


async def test_control_message_cannot_be_deleted_or_pinned(ctx):
    poll_id = await ctx.poll()
    vote_id = (await ctx.vote(poll_id)).json()["data"]["_id"]

    r = await ctx.alice.delete(f"/messages/{vote_id}")
    assert r.status_code == 409
    assert r.json()["error_code"] == "CONTROL_MESSAGE_NOT_ALLOWED"

    r = await ctx.alice.post(f"/messages/{vote_id}/pin")
    assert r.status_code == 409
    assert r.json()["error_code"] == "CONTROL_MESSAGE_NOT_ALLOWED"

    r = await ctx.bob.get(f"/messages/{ctx.chat_id}/polls/{poll_id}/votes")
    assert [m["_id"] for m in r.json()["data"]] == [vote_id]


async def test_replay_with_mismatched_is_control_is_refused(ctx):
    poll_id = await ctx.poll()

    # Stored as an ordinary message, replayed as a vote.
    cid = str(uuid.uuid4())
    assert (await ctx.send(client_message_id=cid)).status_code == 201
    r = await ctx.vote(poll_id, client_message_id=cid)
    assert r.status_code == 409
    assert r.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"

    # Stored as a vote, replayed as an ordinary message.
    cid = str(uuid.uuid4())
    assert (await ctx.vote(poll_id, client_message_id=cid)).status_code == 201
    r = await ctx.send(client_message_id=cid)
    assert r.status_code == 409
    assert r.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_edit_of_a_poll_message_keeps_is_control_false(ctx):
    """The server cannot tell a poll from any other message, so a PUT on one is an ordinary edit."""
    poll_id = await ctx.poll()
    r = await ctx.alice.put(f"/messages/{poll_id}", json={"envelope": ctx.env()})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["is_control"] is False
    assert r.json()["data"]["poll_message_id"] is None


async def test_votes_listing_is_rate_limited_per_user(ctx):
    poll_id = await ctx.poll()
    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    original = settings.RATE_LIMIT_ENABLED
    settings.RATE_LIMIT_ENABLED = True
    try:
        for _ in range(POLL_VOTES_READ_LIMIT + 1):
            try:
                await enforce_rate_limit(
                    redis, scope="poll-votes-read", identifier=str(ctx.bob_id),
                    limit=POLL_VOTES_READ_LIMIT, window_seconds=POLL_VOTES_READ_WINDOW,
                )
            except AppException:
                break
        r = await ctx.bob.get(f"/messages/{ctx.chat_id}/polls/{poll_id}/votes")
        assert r.status_code == 429
    finally:
        settings.RATE_LIMIT_ENABLED = original
        await redis.aclose()


async def test_votes_before_cursor_combines_with_history_floor():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        device, keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)
        await _publish_identity(carol, carol_id)
        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")
        key, skid, ident = await _publish_chain(alice, chat_id, 1, alice_id, device, keys)

        async def post(chain, epoch, skid_, ident_, **extra):
            env = _seal(chain, chat_id, epoch, alice_id, skid_, ident_)
            r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": env, **extra})
            assert r.status_code == 201, r.text
            return r.json()["data"]["_id"]

        chain1 = SenderChain(key)
        poll_id = await post(chain1, 1, skid, ident)
        old = await post(chain1, 1, skid, ident, is_control=True, poll_message_id=poll_id)

        r = await alice.post(f"/chats/{chat_id}/add-participants", json={"user_ids": [str(carol_id)]})
        assert r.status_code == 200, r.text

        key2, skid2, ident2 = await _publish_chain(alice, chat_id, 2, alice_id, device, keys)
        chain2 = SenderChain(key2)
        v = [await post(chain2, 2, skid2, ident2, is_control=True, poll_message_id=poll_id)
             for _ in range(3)]

        url = f"/messages/{chat_id}/polls/{poll_id}/votes"
        r = await carol.get(url, params={"before": v[2], "limit": 10})
        assert [m["_id"] for m in r.json()["data"]] == [v[1], v[0]]   # the pre-join vote is floored out
        r = await carol.get(url, params={"before": v[0]})
        assert r.json()["data"] == []

        r = await alice.get(url, params={"before": v[0]})
        assert [m["_id"] for m in r.json()["data"]] == [old]
    finally:
        for c in (alice, bob, carol):
            await c.aclose()
