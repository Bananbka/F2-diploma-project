from fastapi import APIRouter, Depends
from fastapi import Path
from motor.motor_asyncio import AsyncIOMotorDatabase
from sqlalchemy.ext.asyncio import AsyncSession
from redis.asyncio import Redis

from app.core.responses import SuccessResponse
from app.domains.chats.services.chat_services import get_chat_participants_ids
from app.domains.messages.schemas.messages_schemas import MessageResponse, MessageCreateRequest, MessageUpdateRequest
from app.domains.messages.schemas.ws_schemas import WSMessageEnvelope, WSEventType
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis

router = APIRouter(prefix="/messages", tags=["Messages"])


# MESSAGES CRUD
@router.post("/", response_model=SuccessResponse[MessageResponse])
async def create_message(
        message_in: MessageCreateRequest, user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), redis: Redis = Depends(get_redis),
        mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db)
):
    new_msg = await messages_service.send_message(db, mongo_db, user.id, message_in)

    participant_ids = await get_chat_participants_ids(db, new_msg.chat_id)
    ws_envelope = WSMessageEnvelope(
        event_type=WSEventType.NEW_MESSAGE,
        chat_id=new_msg.chat_id,
        user_id=user.id,
        payload=new_msg.model_dump(mode='json', by_alias=True)
    )

    message_json = ws_envelope.model_dump_json()
    for user_id in participant_ids:
        await redis.publish(f"user:{user_id}", message_json)

    return SuccessResponse(data=new_msg)


@router.put("/{message_id}", response_model=SuccessResponse[MessageResponse])
async def edit_message(
        message_in: MessageUpdateRequest,
        message_id: str = Path(..., description="Message ID"), user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
        redis: Redis = Depends(get_redis)
):
    upd_msg = await messages_service.update_message(db, mongo_db, user.id, message_id, message_in)

    participant_ids = await get_chat_participants_ids(db, upd_msg.chat_id)
    ws_envelope = WSMessageEnvelope(
        event_type=WSEventType.MESSAGE_EDITED,
        chat_id=upd_msg.chat_id,
        user_id=user.id,
        payload=upd_msg.model_dump(mode='json', by_alias=True)
    )

    message_json = ws_envelope.model_dump_json()
    for user_id in participant_ids:
        await redis.publish(f"user:{user_id}", message_json)

    return SuccessResponse(data=upd_msg)


@router.delete("/{message_id}", response_model=SuccessResponse[dict])
async def delete_message(
        message_id: str = Path(..., description="Message ID"), user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
        redis: Redis = Depends(get_redis)
):
    chat_id = await messages_service.delete_message(db, mongo_db, user.id, message_id)

    participant_ids = await get_chat_participants_ids(db, chat_id)
    ws_envelope = WSMessageEnvelope(
        event_type=WSEventType.MESSAGE_DELETED,
        chat_id=chat_id,
        user_id=user.id,
        payload={"message_id": str(message_id)}
    )

    message_json = ws_envelope.model_dump_json()
    for user_id in participant_ids:
        await redis.publish(f"user:{user_id}", message_json)

    return SuccessResponse(data={"message": "Message deleted"})
