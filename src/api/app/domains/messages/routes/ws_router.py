import asyncio

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from loguru import logger
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import ValidationError
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.domains.chats.models import ChatParticipant
from app.domains.chats.services.chat_services import update_participant_last_read
from app.domains.messages.schemas.ws_schemas import WSEventType, WSMessageEnvelope
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_ws_current_user
from app.domains.users.models import User
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis

ws_router = APIRouter()


async def listen_to_redis(pubsub, websocket: WebSocket):
    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                text_data = message["data"]
                await websocket.send_text(text_data)

    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error(f"redis fan-out task failed: {e}")


PRESENCE_TTL_SECONDS = 86400

# A frame larger than this is not a real client. Without a bound, one socket can make the server
# buffer arbitrary amounts before validation ever runs.
MAX_FRAME_BYTES = 64 * 1024


async def _broadcast_presence(
    db: AsyncSession, redis: Redis, user_id, online: bool
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
    ).model_dump_json()

    for peer_id in peer_ids:
        await redis.publish(f"user:{peer_id}", envelope)


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


@ws_router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    user: User = Depends(get_ws_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
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
    channel_name = f"user:{user.id}"

    try:
        connection_count = await redis.incr(f"presence:{user.id}")
        await redis.expire(f"presence:{user.id}", PRESENCE_TTL_SECONDS)
        await redis.set(f"status:{user.id}", "1", ex=PRESENCE_TTL_SECONDS)

        if connection_count == 1:
            await _broadcast_presence(db, redis, user.id, online=True)

        pubsub = redis.pubsub()
        await pubsub.subscribe(channel_name)

        redis_task = asyncio.create_task(listen_to_redis(pubsub, websocket))

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

                    event_json = ws_event.model_dump_json()

                    for p_id in participant_ids:
                        if p_id != user.id:
                            await redis.publish(f"user:{p_id}", event_json)

                elif ws_event.event_type == WSEventType.MESSAGE_READ:
                    last_read_id = ws_event.payload.get("last_read_message_id")

                    if not ws_event.chat_id or not last_read_id:
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

                        event_json = ws_event.model_dump_json()

                        for p_id in participant_ids:
                            await redis.publish(f"user:{p_id}", event_json)

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
                await _broadcast_presence(db, redis, user.id, online=False)
