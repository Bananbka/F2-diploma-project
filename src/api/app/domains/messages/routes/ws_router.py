import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import ValidationError
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.chats.models import ChatParticipant
from app.domains.chats.services.chat_services import update_participant_last_read
from app.domains.messages.schemas.ws_schemas import WSMessageEnvelope, WSEventType
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
        print(f"REDIS TASK ERROR: {e}")


@ws_router.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket,
                             user: User = Depends(get_ws_current_user),
                             db: AsyncSession = Depends(get_db), redis: Redis = Depends(get_redis),
                             mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db)):
    await websocket.accept()

    await redis.set(f"status:{user.id}", "1", ex=86400)

    pubsub = redis.pubsub()
    channel_name = f"user:{user.id}"
    await pubsub.subscribe(channel_name)

    redis_task = asyncio.create_task(listen_to_redis(pubsub, websocket))

    try:
        while True:
            raw = await websocket.receive_json()

            try:
                ws_event = WSMessageEnvelope.model_validate(raw)
                ws_event.user_id = user.id

                if ws_event.event_type in (
                        WSEventType.TYPING_START,
                        WSEventType.TYPING_STOP
                ):
                    if not ws_event.chat_id:
                        continue

                    stmt = select(ChatParticipant.user_id).where(ChatParticipant.chat_id == ws_event.chat_id)
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

                    await update_participant_last_read(db, ws_event.chat_id, user.id, last_read_id)

                    updated_count = await messages_service.mark_messages_as_read(
                        mongo_db, ws_event.chat_id, user.id, last_read_id
                    )

                    if updated_count > 0:
                        stmt = select(ChatParticipant.user_id).where(ChatParticipant.chat_id == ws_event.chat_id)
                        res = await db.execute(stmt)
                        participant_ids = res.scalars().all()

                        event_json = ws_event.model_dump_json()

                        for p_id in participant_ids:
                            await redis.publish(f"user:{p_id}", event_json)


                elif ws_event.event_type in (
                        WSEventType.NEW_MESSAGE,
                        WSEventType.MESSAGE_EDITED,
                        WSEventType.MESSAGE_DELETED
                ):
                    # WSMessageEnvelope sets use_enum_values=True, so event_type is already a str.
                    error_envelope = WSMessageEnvelope(
                        event_type=WSEventType.ERROR,
                        payload={"message": f"Please use HTTP endpoints for {ws_event.event_type}"}
                    )
                    await websocket.send_text(error_envelope.model_dump_json())



            except ValidationError as e:
                error_envelope = WSMessageEnvelope(
                    event_type=WSEventType.ERROR,
                    payload={"details": e.errors()},
                )
                await websocket.send_text(error_envelope.model_dump_json())

    except WebSocketDisconnect:
        pass

    finally:
        redis_task.cancel()
        await pubsub.unsubscribe(channel_name)
        await pubsub.close()

        await redis.set(f"status:{user.id}", "0")
