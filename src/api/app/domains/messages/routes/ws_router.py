import asyncio
import json
import time

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from loguru import logger
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import ValidationError
from redis.asyncio import Redis
from redis.exceptions import ResponseError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.domains.chats.models import ChatParticipant
from app.domains.chats.services.chat_services import update_participant_last_read
from app.domains.messages.schemas.ws_schemas import WSEventType, WSMessageEnvelope
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import (
    check_ws_origin,
    get_ws_current_user,
    ws_session_is_valid,
)
from app.domains.users.models import User
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_events_redis, get_redis
from app.infrastructure.services.event_publisher import (
    EventPublisher,
    channel_name as user_channel,
    extract_stream_id,
    gap_key,
    get_event_publisher,
    parse_stream_id,
    stream_key,
    with_stream_id,
)

ws_router = APIRouter()


# Close code for a socket whose session is no longer valid (4xxx is the application-defined range).
WS_CLOSE_SESSION_REVOKED = 4401


async def _close_revoked(websocket: WebSocket) -> None:
    try:
        await websocket.close(code=WS_CLOSE_SESSION_REVOKED)
    except Exception as exc:
        logger.debug(f"socket already closed while revoking: {exc}")


async def _send_resync(
    websocket: WebSocket, reason: str, cursor: str | None
) -> None:
    """Tell the client its cursor cannot be replayed from, and hand it a fresh one.

    `payload.cursor` is the newest stream id as of now (null if the stream is empty or gone). The
    client reloads over HTTP and adopts it, so it does not present the same dead cursor again on
    its next reconnect. Everything up to it is already persisted, hence covered by that reload.
    """
    await websocket.send_text(
        WSMessageEnvelope(
            event_type=WSEventType.RESYNC_REQUIRED,
            payload={"reason": reason, "cursor": cursor},
        ).model_dump_json()
    )


async def open_subscription(redis: Redis, channel: str, timeout: float = 5.0):
    """Subscribe and wait until Redis has confirmed it.

    `subscribe()` only writes the command. Until the confirmation is read, the server may not yet
    have registered the subscription, and an event published in that window would be neither in
    the stream read that follows (if that read came first) nor buffered on the subscription. The
    replay must start only after this returns.
    """
    pubsub = redis.pubsub()
    await pubsub.subscribe(channel)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError(f"no subscribe confirmation for {channel}")
            message = await pubsub.get_message(
                ignore_subscribe_messages=False, timeout=min(remaining, 1.0)
            )
            if message is not None and message["type"] == "subscribe":
                return pubsub
    except BaseException:
        await pubsub.aclose()
        raise


async def replay_from_cursor(
    websocket: WebSocket, redis: Redis, user_id, cursor: str
) -> tuple[int, int] | None:
    """Send the events this user missed after `cursor`; return the newest stream id covered.

    Must run after the live subscription is confirmed (see `open_subscription`): anything
    published from then on is both in the stream and buffered on the subscription, and the live
    listener drops the copies at or below the returned id.

    The reads run in one MULTI so a concurrent trim cannot slip between the bounds check and the
    range read and leave a silent gap.
    """
    key = stream_key(user_id)
    parsed = parse_stream_id(cursor)

    results = None
    if parsed is not None:
        try:
            async with redis.pipeline(transaction=True) as pipe:
                pipe.xrange(key, "-", "+", count=1)
                pipe.xrevrange(key, "+", "-", count=1)
                pipe.get(gap_key(user_id))
                pipe.xrange(
                    key, f"({cursor}", "+", count=settings.WS_REPLAY_MAX_EVENTS + 1
                )
                results = await pipe.execute()
        except ResponseError as exc:
            # A syntactically valid id Redis still refuses (e.g. the exclusive range after the
            # largest possible id). Same outcome as a malformed one: reload over HTTP.
            logger.info(f"replay refused cursor {cursor!r}: {exc}")

    if results is None:
        await _send_resync(websocket, "invalid_cursor", None)
        return None

    first, last, gap_ms, entries = results
    last_id = last[0][0] if last else None
    last_parsed = parse_stream_id(last_id) if last_id else None

    reason = None
    adopt = last_id
    if gap_ms is not None and parsed[0] <= int(gap_ms):
        # An event after this cursor could not be stored. The client's next cursor must come from
        # an event stored after the gap, so none is offered here; it simply has no cursor until
        # the next live event, which is the pre-stream behaviour.
        reason = "stream_gap"
        adopt = None
    elif not first:
        reason = "stream_missing"  # never written, or expired after the TTL
    elif parsed < parse_stream_id(first[0][0]):
        reason = "cursor_too_old"  # entries after the cursor may have been trimmed
    elif parsed > last_parsed:
        reason = "cursor_ahead"  # not an id this stream ever issued
    elif len(entries) > settings.WS_REPLAY_MAX_EVENTS:
        reason = "too_many_events"

    if reason is not None:
        await _send_resync(websocket, reason, adopt)
        return last_parsed

    newest = parsed
    for entry_id, fields in entries:
        await websocket.send_text(with_stream_id(fields["e"], entry_id))
        newest = parse_stream_id(entry_id)
    return newest


async def listen_to_redis(
    pubsub,
    websocket: WebSocket,
    redis: Redis,
    token: str,
    replayed_through: tuple[int, int] | None = None,
):
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                text_data = message["data"]

                # Already delivered by the replay: the subscription was opened before the replay
                # read, so events from that window arrive on both paths. Stream ids are
                # monotonic per user, so "at or below the last replayed id" means a duplicate.
                if replayed_through is not None:
                    live_id = extract_stream_id(text_data)
                    if live_id is not None and live_id <= replayed_through:
                        continue

                # A revocation is never relayed. Each socket re-validates its own token, so a
                # logout that revoked only one token closes only the sockets using it.
                if '"session_revoked"' in text_data:
                    try:
                        is_revocation = (
                            json.loads(text_data).get("event_type")
                            == WSEventType.SESSION_REVOKED.value
                        )
                    except ValueError:
                        is_revocation = False

                    if is_revocation:
                        if not await ws_session_is_valid(redis, token):
                            await _close_revoked(websocket)
                            return
                        continue

                await websocket.send_text(text_data)

    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error(f"redis fan-out task failed: {e}")


async def watch_session(websocket: WebSocket, redis: Redis, token: str):
    """Backstop for revocations that publish nothing: token expiry and a disabled account."""
    try:
        while True:
            await asyncio.sleep(settings.WS_SESSION_RECHECK_SECONDS)
            if not await ws_session_is_valid(redis, token):
                await _close_revoked(websocket)
                return
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error(f"session watcher failed: {e}")


class TokenBucket:
    """Per-socket allowance for inbound frames that fan out to other users."""

    def __init__(self, capacity: float, refill_per_second: float):
        self.capacity = capacity
        self.refill = refill_per_second
        self.tokens = capacity
        self.updated = time.monotonic()

    def allow(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.refill)
        self.updated = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


# Typing and read frames are relayed to every other member, so one socket can otherwise turn a
# flood of tiny frames into a flood of publishes. A burst of 10 then 2 per second is far above
# what a person produces.
RELAY_BUCKET_CAPACITY = 10
RELAY_BUCKET_REFILL_PER_SECOND = 2
RELAY_THROTTLE_NOTICE_INTERVAL = 5.0

# What a client may put in `payload` for each event it can send. Anything else is dropped before
# the frame is relayed to peers, so the field cannot be used to smuggle data to other users.
ALLOWED_INBOUND_PAYLOAD_KEYS: dict[str, frozenset[str]] = {
    WSEventType.TYPING_START.value: frozenset(),
    WSEventType.TYPING_STOP.value: frozenset(),
    WSEventType.MESSAGE_READ.value: frozenset({"last_read_message_id"}),
}


PRESENCE_TTL_SECONDS = 86400

# A frame larger than this is not a real client. Without a bound, one socket can make the server
# buffer arbitrary amounts before validation ever runs.
MAX_FRAME_BYTES = 64 * 1024


async def _broadcast_presence(
    db: AsyncSession, publisher: EventPublisher, user_id, online: bool
) -> None:
    """Tell this user's conversation partners that they came online or went offline.

    USER_ONLINE and USER_OFFLINE were declared in the event enum and handled in the client, but
    nothing ever published them — presence was written to Redis and read by no one. Fan-out is
    per-user like everything else, so the peers have to be resolved from Postgres first.
    """
    my_chats = select(ChatParticipant.chat_id).where(ChatParticipant.user_id == user_id)

    peer_ids = (
        (
            await db.execute(
                select(ChatParticipant.user_id)
                .where(
                    ChatParticipant.chat_id.in_(my_chats),
                    ChatParticipant.user_id != user_id,
                )
                .distinct()
            )
        )
        .scalars()
        .all()
    )

    if not peer_ids:
        return

    envelope = WSMessageEnvelope(
        event_type=WSEventType.USER_ONLINE if online else WSEventType.USER_OFFLINE,
        user_id=user_id,
        payload={"user_id": str(user_id), "online": online},
    )

    # Ephemeral: presence is a fact about now, and a replayed "online" would be a lie.
    await publisher.publish_ephemeral(envelope, peer_ids)


async def _may_act_on(db: AsyncSession, user_id, chat_id, websocket: WebSocket) -> bool:
    """Authorise a socket event against Postgres before it touches anything.

    The socket used to take `chat_id` straight from the frame. Nothing checked membership, so any
    authenticated user could publish typing indicators into conversations they had never been part
    of, and — worse — drive `mark_messages_as_read` against an arbitrary chat, flipping `is_read`
    on other people's messages and wiping their unread counts.

    Access control lives in Postgres and content lives in Mongo, so the Postgres check has to come
    first on every path that reaches Mongo. This is the socket's half of `get_chat_or_403`.
    """
    if await messages_service.is_user_in_chat(db, user_id, chat_id) is not None:
        return True

    await websocket.send_text(
        WSMessageEnvelope(
            event_type=WSEventType.ERROR,
            chat_id=chat_id,
            payload={
                "error_code": "FORBIDDEN",
                "message": "You are not a participant of this chat.",
            },
        ).model_dump_json()
    )
    return False


@ws_router.websocket("/ws", dependencies=[Depends(check_ws_origin)])
async def websocket_endpoint(
    websocket: WebSocket,
    user: User = Depends(get_ws_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    publisher: EventPublisher = Depends(get_event_publisher),
    events_redis: Redis = Depends(get_events_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
    cursor: str | None = Query(
        default=None,
        max_length=64,
        description="Last stream_id the client saw; missed events are replayed after it.",
    ),
):
    await websocket.accept()

    # Presence is refcounted, not a flag. With a plain set/clear, closing one of two open tabs
    # marked the user offline while they were still connected in the other.
    #
    # The increment is the first thing inside the try, so that *anything* failing afterwards —
    # the presence broadcast, the pubsub subscribe — still decrements on the way out. Incrementing
    # before the try left the counter stuck on any such failure, and a stuck counter means the
    # user reads as permanently online and no later connection ever announces them again.
    connection_count = 0
    pubsub = None
    redis_task = None
    channel_name = user_channel(user.id)
    token = websocket.cookies.get("access_token")
    watcher_task = None
    relay_bucket = TokenBucket(RELAY_BUCKET_CAPACITY, RELAY_BUCKET_REFILL_PER_SECOND)
    last_throttle_notice = 0.0

    try:
        connection_count = await redis.incr(f"presence:{user.id}")
        await redis.expire(f"presence:{user.id}", PRESENCE_TTL_SECONDS)
        await redis.set(f"status:{user.id}", "1", ex=PRESENCE_TTL_SECONDS)

        if connection_count == 1:
            await _broadcast_presence(db, publisher, user.id, online=True)

        pubsub = await open_subscription(events_redis, channel_name)

        # Subscribe first, replay second, listen third. A durable event is appended and published
        # in one atomic step, so an event is either already in the stream when the replay reads it,
        # or published after the subscribe and therefore buffered here. Events in the overlap are
        # seen twice and the listener drops the second copy by stream id; nothing falls between.
        replayed_through = None
        if cursor is not None:
            try:
                await enforce_rate_limit(
                    redis,
                    scope="ws-replay",
                    identifier=str(user.id),
                    limit=settings.WS_REPLAY_CONNECT_LIMIT,
                    window_seconds=settings.WS_REPLAY_CONNECT_WINDOW,
                )
            except AppException:
                # Replay is a read amplifier, so reconnect storms are bounded. The fallback is
                # the pre-stream behaviour: reload over HTTP, then live.
                await _send_resync(websocket, "rate_limited", None)
            else:
                replayed_through = await replay_from_cursor(
                    websocket, events_redis, user.id, cursor
                )

        redis_task = asyncio.create_task(
            listen_to_redis(pubsub, websocket, redis, token, replayed_through)
        )
        watcher_task = asyncio.create_task(watch_session(websocket, redis, token))

        while True:
            # receive_text, not receive_json: a frame that is not valid JSON used to raise out of
            # the loop past the WebSocketDisconnect handler and tear the connection down, so one
            # malformed frame disconnected the client instead of being answered with an error.
            text = await websocket.receive_text()

            if len(text) > MAX_FRAME_BYTES:
                await websocket.send_text(
                    WSMessageEnvelope(
                        event_type=WSEventType.ERROR,
                        payload={
                            "error_code": "FRAME_TOO_LARGE",
                            "message": "Frame exceeds the size limit.",
                        },
                    ).model_dump_json()
                )
                continue

            try:
                ws_event = WSMessageEnvelope.model_validate_json(text)
                ws_event.user_id = user.id
                ws_event.stream_id = None  # never client-controlled

                allowed_keys = ALLOWED_INBOUND_PAYLOAD_KEYS.get(ws_event.event_type)
                if allowed_keys is not None:
                    ws_event.payload = {
                        k: v for k, v in ws_event.payload.items() if k in allowed_keys
                    }

                    if not relay_bucket.allow():
                        now = time.monotonic()
                        if now - last_throttle_notice >= RELAY_THROTTLE_NOTICE_INTERVAL:
                            last_throttle_notice = now
                            await websocket.send_text(
                                WSMessageEnvelope(
                                    event_type=WSEventType.ERROR,
                                    payload={
                                        "error_code": "RATE_LIMITED",
                                        "message": "Too many events. Slow down.",
                                    },
                                ).model_dump_json()
                            )
                        continue

                if ws_event.event_type in (
                    WSEventType.TYPING_START,
                    WSEventType.TYPING_STOP,
                ):
                    if not ws_event.chat_id:
                        continue

                    if not await _may_act_on(db, user.id, ws_event.chat_id, websocket):
                        continue

                    stmt = select(ChatParticipant.user_id).where(
                        ChatParticipant.chat_id == ws_event.chat_id
                    )
                    res = await db.execute(stmt)
                    participant_ids = res.scalars().all()

                    await publisher.publish_ephemeral(
                        ws_event, [p_id for p_id in participant_ids if p_id != user.id]
                    )

                elif ws_event.event_type == WSEventType.MESSAGE_READ:
                    last_read_id = ws_event.payload.get("last_read_message_id")

                    if (
                        not ws_event.chat_id
                        or not last_read_id
                        or not isinstance(last_read_id, str)
                    ):
                        continue

                    # Validate and canonicalize before anything touches Postgres or Mongo.
                    # `objectify_id` raises AppException (caught below) on a malformed id, and
                    # the canonical `str(ObjectId(...))` form is what both the monotonicity
                    # guard and the Mongo read-mark write must compare against — otherwise a
                    # case-variant but valid id (e.g. uppercase hex) would be stored verbatim
                    # and no longer byte-compare consistently against genuine lowercase-hex
                    # ObjectId strings.
                    last_read_id = str(messages_service.objectify_id(last_read_id))
                    ws_event.payload["last_read_message_id"] = last_read_id

                    if not await _may_act_on(db, user.id, ws_event.chat_id, websocket):
                        continue

                    advanced = await update_participant_last_read(
                        db, ws_event.chat_id, user.id, last_read_id
                    )

                    # Still called for its (deprecated) side effect on the legacy shared `is_read`
                    # flag — see the note on `mark_messages_as_read`. Its modified count must not
                    # gate the broadcast below: it is scoped to other members' messages, so a
                    # reader catching up on only their own sends, or on a range another reader
                    # already flipped, would otherwise never announce their own advancing mark.
                    await messages_service.mark_messages_as_read(
                        db, mongo_db, ws_event.chat_id, user.id, last_read_id
                    )

                    if advanced:
                        stmt = select(ChatParticipant.user_id).where(
                            ChatParticipant.chat_id == ws_event.chat_id
                        )
                        res = await db.execute(stmt)
                        participant_ids = res.scalars().all()

                        # Ephemeral: the read position is recovered over HTTP, so a missed
                        # receipt is not worth a stream entry.
                        await publisher.publish_ephemeral(ws_event, participant_ids)

                elif ws_event.event_type in (
                    WSEventType.NEW_MESSAGE,
                    WSEventType.MESSAGE_EDITED,
                    WSEventType.MESSAGE_DELETED,
                ):
                    # WSMessageEnvelope sets use_enum_values=True, so event_type is already a str.
                    error_envelope = WSMessageEnvelope(
                        event_type=WSEventType.ERROR,
                        payload={
                            "message": f"Please use HTTP endpoints for {ws_event.event_type}"
                        },
                    )
                    await websocket.send_text(error_envelope.model_dump_json())

            except ValidationError as e:
                error_envelope = WSMessageEnvelope(
                    event_type=WSEventType.ERROR,
                    payload={"details": e.errors()},
                )
                await websocket.send_text(error_envelope.model_dump_json())

            except AppException as e:
                # The HTTP exception handlers registered in main.py do not run for a socket, so an
                # AppException raised by a service (a bad message id, a failed authorisation)
                # would otherwise escape the loop and drop the connection.
                await websocket.send_text(
                    WSMessageEnvelope(
                        event_type=WSEventType.ERROR,
                        payload={"error_code": e.error_code, "message": e.message},
                    ).model_dump_json()
                )

    except WebSocketDisconnect:
        pass

    finally:
        # Each step guarded, because the increment above may have been the only one that ran —
        # and a teardown that raises half way through would skip the decrement it exists for.
        if redis_task is not None:
            redis_task.cancel()

        if watcher_task is not None:
            watcher_task.cancel()

        if pubsub is not None:
            try:
                await pubsub.unsubscribe(channel_name)
                await pubsub.close()
            except Exception as exc:
                logger.warning(f"pubsub teardown failed for {user.id}: {exc}")

        if connection_count:
            remaining = await redis.decr(f"presence:{user.id}")

            if remaining <= 0:
                # Left at zero rather than deleted. Deleting races a connection that increments
                # between the decr and the delete — that connection would see 1, announce the
                # user online, and then have its count thrown away. A key sitting at 0 costs
                # nothing, expires on its own, and increments back to 1 correctly.
                await redis.set(f"status:{user.id}", "0")
                await _broadcast_presence(db, publisher, user.id, online=False)
