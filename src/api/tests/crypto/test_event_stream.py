"""Per-user event stream: durable events, cursor replay, `resync_required`, TB-20.

Talks to the running API over a real WebSocket (`websockets`) and to Redis directly. The one
exception is the publisher-failure test, which needs a dependency override and therefore drives
the app in-process, authenticating with the cookies of a user registered over HTTP.
"""

import asyncio
import json
import uuid

import httpx
import pytest
import redis.asyncio as aioredis
import websockets

from app.core.config import settings
from app.domains.messages.routes import ws_router as ws_module
from app.infrastructure.services import event_publisher as ep_module
from app.domains.messages.schemas.ws_schemas import WSEventType, WSMessageEnvelope
from app.infrastructure.services.event_publisher import (
    RedisEventPublisher,
    gap_key,
    parse_stream_id,
    stream_key,
)

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user, rate_limit_bypass_headers
from tests.crypto.test_message_crud_api import _send

WS_URL = "ws://localhost:8000/ws"
ORIGIN = "http://localhost:4200"


def _mid(message: dict) -> str:
    return message.get("_id") or message["id"]


def _connect(client: httpx.AsyncClient, cursor: str | None = None):
    cookie = "; ".join(f"{k}={v}" for k, v in client.cookies.items())
    url = WS_URL if cursor is None else f"{WS_URL}?cursor={cursor}"
    return websockets.connect(
        url, additional_headers={"Origin": ORIGIN, "Cookie": cookie}
    )


async def _recv(ws, timeout=3.0) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def _recv_type(ws, event_type: str, timeout=3.0) -> dict:
    """Next event of one type, skipping presence noise from other connections."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        event = await _recv(ws, max(remaining, 0.01))
        if event["event_type"] == event_type:
            return event


async def _silent(ws, timeout=0.6) -> bool:
    """True if nothing but presence events arrives within `timeout`."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            return True
        try:
            event = await _recv(ws, remaining)
        except TimeoutError:
            return True
        if event["event_type"] not in ("user_online", "user_offline"):
            return False


async def _wait_subscribed(redis_client, user_id, timeout=3.0):
    """The server subscribes after accept(); wait until it has, instead of sleeping."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while (await redis_client.pubsub_numsub(f"user:{user_id}"))[0][1] < 1:
        assert loop.time() < deadline, "socket never subscribed"
        await asyncio.sleep(0.02)


@pytest.fixture
async def redis_client():
    client = aioredis.from_url(settings.EVENTS_REDIS_URL, decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


async def _pair():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    chat_id = await _group_with(alice, bob_id)
    return alice, alice_id, bob, bob_id, chat_id


async def test_live_events_carry_stream_id():
    alice, _, bob, bob_id, chat_id = await _pair()
    try:
        async with _connect(bob) as ws:
            await _send(alice, chat_id, "one")
            event = await _recv_type(ws, "new_message")
            assert parse_stream_id(event["stream_id"]) is not None
            assert event["payload"]["encrypted_content"] == "one"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_replay_after_disconnect_returns_missed_events_in_order():
    alice, _, bob, bob_id, chat_id = await _pair()
    try:
        async with _connect(bob) as ws:
            await _send(alice, chat_id, "m1")
            first = await _recv_type(ws, "new_message")
            cursor = first["stream_id"]

        missed = [_mid(await _send(alice, chat_id, f"m{i}")) for i in (2, 3, 4)]

        async with _connect(bob, cursor) as ws:
            got = [await _recv_type(ws, "new_message") for _ in missed]
            assert [_mid(e["payload"]) for e in got] == missed
            ids = [parse_stream_id(e["stream_id"]) for e in got]
            assert ids == sorted(ids) and len(set(ids)) == 3
            assert ids[0] > parse_stream_id(cursor)  # exclusive start

            # Then live, with no duplicate of anything replayed.
            await _send(alice, chat_id, "m5")
            live = await _recv_type(ws, "new_message")
            assert live["payload"]["encrypted_content"] == "m5"
            assert parse_stream_id(live["stream_id"]) > ids[-1]
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_no_cursor_means_no_replay():
    alice, _, bob, _, chat_id = await _pair()
    try:
        await _send(alice, chat_id, "while offline")
        async with _connect(bob) as ws:
            assert await _silent(ws)
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_cursor_at_head_replays_nothing_and_goes_live():
    alice, _, bob, _, chat_id = await _pair()
    try:
        async with _connect(bob) as ws:
            await _send(alice, chat_id, "m1")
            cursor = (await _recv_type(ws, "new_message"))["stream_id"]

        async with _connect(bob, cursor) as ws:
            assert await _silent(ws)
            await _send(alice, chat_id, "m2")
            assert (await _recv_type(ws, "new_message"))["payload"]["encrypted_content"] == "m2"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_trimmed_cursor_requires_resync(redis_client):
    alice, _, bob, bob_id, chat_id = await _pair()
    try:
        async with _connect(bob) as ws:
            await _send(alice, chat_id, "m1")
            cursor = (await _recv_type(ws, "new_message"))["stream_id"]

        for i in (2, 3, 4):
            await _send(alice, chat_id, f"m{i}")
        # Exact trim: the cursor's successors are gone, so a replay would silently skip them.
        await redis_client.xtrim(stream_key(bob_id), maxlen=1, approximate=False)
        newest = (await redis_client.xrevrange(stream_key(bob_id), count=1))[0][0]

        async with _connect(bob, cursor) as ws:
            event = await _recv_type(ws, "resync_required")
            assert event["payload"]["reason"] == "cursor_too_old"
            assert event["payload"]["cursor"] == newest
            assert event.get("stream_id") is None
            # And the socket is still usable afterwards.
            await _send(alice, chat_id, "m5")
            assert (await _recv_type(ws, "new_message"))["payload"]["encrypted_content"] == "m5"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_expired_ahead_and_malformed_cursors_require_resync(redis_client):
    alice, _, bob, bob_id, chat_id = await _pair()
    try:
        async with _connect(bob) as ws:
            await _send(alice, chat_id, "m1")
            cursor = (await _recv_type(ws, "new_message"))["stream_id"]

        async with _connect(bob, "99999999999999-0") as ws:
            event = await _recv_type(ws, "resync_required")
            assert event["payload"]["reason"] == "cursor_ahead"

        async with _connect(bob, "not-a-cursor") as ws:
            event = await _recv_type(ws, "resync_required")
            assert event["payload"]["reason"] == "invalid_cursor"

        await redis_client.delete(stream_key(bob_id))  # what TTL expiry does
        async with _connect(bob, cursor) as ws:
            event = await _recv_type(ws, "resync_required")
            assert event["payload"]["reason"] == "stream_missing"
            assert event["payload"]["cursor"] is None
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_stream_has_ttl_and_cap_and_metadata_only_entries(redis_client):
    alice, _, bob, bob_id, chat_id = await _pair()
    try:
        await _send(alice, chat_id, "ttl")
        key = stream_key(bob_id)

        ttl = await redis_client.ttl(key)
        assert settings.EVENT_STREAM_TTL_SECONDS - 60 < ttl <= settings.EVENT_STREAM_TTL_SECONDS

        entries = await redis_client.xrange(key)
        stored = json.loads(entries[-1][1]["e"])
        # The id is the entry id; the stored copy is the envelope as it was always published.
        assert "stream_id" not in stored
        assert stored["event_type"] == "new_message"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_typing_is_published_but_never_stored(redis_client):
    alice, _, bob, bob_id, chat_id = await _pair()
    try:
        before = await redis_client.xlen(stream_key(bob_id))
        async with _connect(alice) as alice_ws, _connect(bob) as bob_ws:
            await _wait_subscribed(redis_client, bob_id)
            await alice_ws.send(
                json.dumps({"event_type": "typing_start", "chat_id": str(chat_id)})
            )
            event = await _recv_type(bob_ws, "typing_start")
            assert event.get("stream_id") is None

        assert await redis_client.xlen(stream_key(bob_id)) == before
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_publish_failure_after_save_keeps_201_and_message():
    from app.main import app
    from app.infrastructure.services.event_publisher import get_event_publisher

    alice, alice_id, bob, bob_id, chat_id = await _pair()

    class BrokenPublisher:
        async def publish_durable(self, *a, **kw):
            raise ConnectionError("redis went away")

        publish_ephemeral = publish_durable

    app.dependency_overrides[get_event_publisher] = lambda: BrokenPublisher()
    try:
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://localhost:8000",
                cookies=alice.cookies,
                headers=rate_limit_bypass_headers(),
            ) as inproc:
                r = await inproc.post(
                    "/messages/",
                    json={"chat_id": str(chat_id), "encrypted_content": "survives"},
                )
                assert r.status_code == 201, r.text

                # Retrying must not duplicate: the client has no reason to, because it got a 201.
                r2 = await inproc.get(f"/chats/{chat_id}/messages")
                contents = [m["encrypted_content"] for m in r2.json()["data"]]
                assert contents.count("survives") == 1
    finally:
        app.dependency_overrides.pop(get_event_publisher, None)
        await alice.aclose()
        await bob.aclose()


# ---------------------------------------------------------------------------------------------
# In-process tests against synthetic users (no Postgres rows are needed for stream mechanics).
# ---------------------------------------------------------------------------------------------


class FakeWS:
    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, text):
        self.sent.append(text)

    @property
    def events(self) -> list[dict]:
        return [json.loads(t) for t in self.sent]


def _envelope(**payload):
    return WSMessageEnvelope(event_type=WSEventType.NEW_MESSAGE, payload=payload)


async def _eventually(predicate, timeout=3.0):
    """Poll a condition with a bound instead of sleeping a fixed time."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline, "condition not reached in time"
        await asyncio.sleep(0.02)


async def _next_message(pubsub, timeout=3.0) -> str:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        assert remaining > 0, "no pubsub message in time"
        message = await pubsub.get_message(timeout=remaining)
        if message is not None and message["type"] == "message":
            return message["data"]


@pytest.fixture
async def synthetic(redis_client):
    created: list[uuid.UUID] = []

    def make(n=1):
        ids = [uuid.uuid4() for _ in range(n)]
        created.extend(ids)
        return ids

    yield make
    for uid in created:
        await redis_client.delete(stream_key(uid), gap_key(uid))


async def test_replay_live_boundary_neither_loses_nor_duplicates(redis_client, synthetic):
    """Events published between subscribe and replay arrive on both paths; exactly one is kept."""
    (uid,) = synthetic()
    publisher = RedisEventPublisher(redis_client)
    await publisher.publish_durable(_envelope(n=0), [uid])
    cursor = (await redis_client.xrevrange(stream_key(uid), count=1))[0][0]

    # The real order: confirmed subscription, then events, then the replay read.
    pubsub = await ws_module.open_subscription(redis_client, f"user:{uid}")
    await publisher.publish_durable(_envelope(n=1), [uid])  # lands on both paths

    replay_ws = FakeWS()
    replayed_through = await ws_module.replay_from_cursor(replay_ws, redis_client, uid, cursor)
    await publisher.publish_durable(_envelope(n=2), [uid])  # after the replay read: live only

    live_ws = FakeWS()
    task = asyncio.create_task(
        ws_module.listen_to_redis(pubsub, live_ws, redis_client, "tok", replayed_through)
    )
    await _eventually(lambda: len(live_ws.sent) >= 1)
    await asyncio.sleep(0.2)  # a duplicate, if any, would have arrived by now
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await pubsub.aclose()

    assert [e["payload"]["n"] for e in replay_ws.events] == [1]
    assert [e["payload"]["n"] for e in live_ws.events] == [2]


async def test_replay_cap_requires_resync(redis_client, synthetic, monkeypatch):
    (uid,) = synthetic()
    publisher = RedisEventPublisher(redis_client)
    for n in range(4):
        await publisher.publish_durable(_envelope(n=n), [uid])
    first_id = (await redis_client.xrange(stream_key(uid), count=1))[0][0]

    monkeypatch.setattr(settings, "WS_REPLAY_MAX_EVENTS", 2)
    ws = FakeWS()
    await ws_module.replay_from_cursor(ws, redis_client, uid, first_id)  # 3 events after it
    assert [e["event_type"] for e in ws.events] == ["resync_required"]
    assert ws.events[0]["payload"]["reason"] == "too_many_events"


async def test_payload_with_unicode_quotes_and_braces_survives_the_splice(
    redis_client, synthetic
):
    (uid,) = synthetic()
    await RedisEventPublisher(redis_client).publish_durable(_envelope(n=0), [uid])
    cursor = (await redis_client.xrevrange(stream_key(uid), count=1))[0][0]
    nasty = 'ключ "q" } {"stream_id":"1-1"} \\ \n 😀  '
    pubsub = await ws_module.open_subscription(redis_client, f"user:{uid}")
    await RedisEventPublisher(redis_client).publish_durable(_envelope(t=nasty), [uid])

    raw = await _next_message(pubsub)
    live = json.loads(raw)
    entry_id, _ = (await redis_client.xrange(stream_key(uid)))[-1]
    assert live["payload"]["t"] == nasty
    assert live["stream_id"] == entry_id
    assert ep_module.extract_stream_id(raw) == parse_stream_id(entry_id)

    ws = FakeWS()
    await ws_module.replay_from_cursor(ws, redis_client, uid, cursor)
    assert ws.events[0]["payload"]["t"] == nasty and ws.events[0]["stream_id"] == entry_id
    await pubsub.aclose()


async def test_multi_recipient_fan_out_and_chunking(redis_client, synthetic, monkeypatch):
    monkeypatch.setattr(ep_module, "FAN_OUT_CHUNK", 2)  # 5 recipients -> 3 pipelines
    uids = synthetic(5)
    subs = [await ws_module.open_subscription(redis_client, f"user:{u}") for u in uids]

    await RedisEventPublisher(redis_client).publish_durable(_envelope(n=1), uids)

    for uid, sub in zip(uids, subs):
        entries = await redis_client.xrange(stream_key(uid))
        assert len(entries) == 1
        # Each recipient's live copy carries the id from that recipient's own stream.
        assert json.loads(await _next_message(sub))["stream_id"] == entries[0][0]
        await sub.aclose()


async def test_ephemeral_events_never_reach_the_stream(redis_client, synthetic):
    (uid,) = synthetic()
    pubsub = await ws_module.open_subscription(redis_client, f"user:{uid}")
    publisher = RedisEventPublisher(redis_client)
    kinds = (
        WSEventType.TYPING_START,
        WSEventType.USER_ONLINE,
        WSEventType.MESSAGE_READ,
        WSEventType.SESSION_REVOKED,
    )
    for event_type in kinds:
        await publisher.publish_ephemeral(WSMessageEnvelope(event_type=event_type), [uid])

    assert await redis_client.exists(stream_key(uid)) == 0
    seen = [json.loads(await _next_message(pubsub)) for _ in kinds]
    assert all("stream_id" not in e for e in seen)
    await pubsub.aclose()


async def test_oversized_event_is_published_live_and_leaves_a_gap(
    redis_client, synthetic, monkeypatch
):
    (uid,) = synthetic()
    publisher = RedisEventPublisher(redis_client)
    await publisher.publish_durable(_envelope(n=1), [uid])
    cursor = (await redis_client.xrevrange(stream_key(uid), count=1))[0][0]

    pubsub = await ws_module.open_subscription(redis_client, f"user:{uid}")
    monkeypatch.setattr(settings, "EVENT_STREAM_MAX_ENTRY_BYTES", 64)
    await publisher.publish_durable(_envelope(big="x" * 500), [uid])

    live = json.loads(await _next_message(pubsub))
    assert "stream_id" not in live  # delivered live, just not stored
    await pubsub.aclose()
    assert await redis_client.xlen(stream_key(uid)) == 1
    assert 0 < await redis_client.ttl(gap_key(uid)) <= settings.EVENT_STREAM_TTL_SECONDS

    ws = FakeWS()
    await ws_module.replay_from_cursor(ws, redis_client, uid, cursor)
    assert ws.events[0]["event_type"] == "resync_required"
    assert ws.events[0]["payload"] == {"reason": "stream_gap", "cursor": None}


async def test_failed_xadd_still_publishes_and_marks_the_gap(redis_client, synthetic):
    """A stream that cannot be appended to (here: wrong type; in production: out of memory)."""
    (uid,) = synthetic()
    await redis_client.set(stream_key(uid), "not a stream")
    pubsub = await ws_module.open_subscription(redis_client, f"user:{uid}")

    await RedisEventPublisher(redis_client).publish_durable(_envelope(n=1), [uid])

    assert json.loads(await _next_message(pubsub))["payload"]["n"] == 1
    assert await redis_client.exists(gap_key(uid)) == 1
    await pubsub.aclose()


@pytest.mark.parametrize(
    "cursor",
    [
        "١٢٣-١",  # Arabic-Indic digits: int() accepts them, Redis does not
        "18446744073709551616-0",  # ms above 2**64 - 1
        "0-18446744073709551616",  # seq above 2**64 - 1
        "18446744073709551615-18446744073709551615",  # valid, but no exclusive range after it
        "1-2-3",
        "",
    ],
)
async def test_unusable_cursors_resync_as_invalid(redis_client, synthetic, cursor):
    (uid,) = synthetic()
    await RedisEventPublisher(redis_client).publish_durable(_envelope(n=1), [uid])
    ws = FakeWS()
    await ws_module.replay_from_cursor(ws, redis_client, uid, cursor)
    assert [e["event_type"] for e in ws.events] == ["resync_required"]
    assert ws.events[0]["payload"]["reason"] == "invalid_cursor"


async def test_account_deletion_removes_the_users_stream(redis_client):
    from tests.crypto.test_account_deletion import PASSWORD, _delete_account

    alice, _, bob, bob_id, chat_id = await _pair()
    try:
        await _send(alice, chat_id, "before deletion")
        await redis_client.set(gap_key(bob_id), "1")
        assert await redis_client.exists(stream_key(bob_id)) == 1

        r = await _delete_account(bob, PASSWORD)
        assert r.status_code == 200, r.text

        assert await redis_client.exists(stream_key(bob_id), gap_key(bob_id)) == 0
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_session_revoked_still_closes_the_socket():
    alice, _, bob, _, _ = await _pair()
    try:
        async with _connect(bob) as ws:
            r = await bob.post("/auth/logout")
            assert r.status_code == 200, r.text
            with pytest.raises(websockets.ConnectionClosed) as closed:
                while True:
                    await _recv(ws)
            assert closed.value.rcvd.code == 4401
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_cursor_connects_are_rate_limited():
    alice, _, bob, _, _ = await _pair()
    try:
        reasons = []
        for _ in range(settings.WS_REPLAY_CONNECT_LIMIT + 1):
            async with _connect(bob, "1-1") as ws:
                reasons.append((await _recv_type(ws, "resync_required"))["payload"]["reason"])
        assert reasons[0] != "rate_limited"
        assert reasons[-1] == "rate_limited"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_stream_evicted_under_memory_pressure_degrades_to_resync(redis_client, synthetic):
    """The events Redis is allkeys-lru: under pressure whole streams vanish, and a reconnecting
    client must be told to reload rather than be silently handed a partial history."""
    (uid,) = synthetic()
    publisher = RedisEventPublisher(redis_client)
    await publisher.publish_durable(_envelope(n=1), [uid])
    cursor = (await redis_client.xrevrange(stream_key(uid), count=1))[0][0]

    policy = (await redis_client.config_get("maxmemory-policy"))["maxmemory-policy"]
    assert policy == "allkeys-lru"
    old_max = (await redis_client.config_get("maxmemory"))["maxmemory"]
    used = (await redis_client.info("memory"))["used_memory"]
    junk: list[str] = []
    try:
        await redis_client.config_set("maxmemory", str(used + 512 * 1024))
        for i in range(20000):
            key = f"test-evict-junk:{uuid.uuid4()}"
            junk.append(key)
            await redis_client.set(key, "x" * 1024, ex=120)
            if i % 50 == 0 and not await redis_client.exists(stream_key(uid)):
                break
        assert not await redis_client.exists(stream_key(uid)), "stream was never evicted"
    finally:
        await redis_client.config_set("maxmemory", old_max)
        if junk:
            await redis_client.delete(*junk)

    ws = FakeWS()
    await ws_module.replay_from_cursor(ws, redis_client, uid, cursor)
    assert [e["event_type"] for e in ws.events] == ["resync_required"]
    assert ws.events[0]["payload"]["reason"] == "stream_missing"
