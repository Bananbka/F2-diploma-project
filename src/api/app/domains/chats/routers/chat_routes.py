import uuid

from fastapi import APIRouter, Depends, Path, Query
from motor.motor_asyncio import AsyncIOMotorDatabase
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.responses import SuccessResponse
from app.domains.chats.models import ParticipantRole, ChatType
from app.domains.chats.schemas.chat_schemas import ChatResponse, PrivateChatCreateRequest, GroupChatCreateRequest, \
    UserListRequest, ChatParticipantResponse, ChangeRoleRequest, ChannelCreateRequest
from app.domains.chats.services import chat_services
from app.domains.messages.schemas.messages_schemas import MessageResponse
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis
from app.infrastructure.services import redis_service

router = APIRouter(prefix='/chats', tags=['Chats'])


async def _announce_epoch(db: AsyncSession, redis: Redis, chat_id: uuid.UUID, epoch) -> None:
    """Notify remaining members that a new key epoch opened. No-op for unencrypted chats."""
    if epoch is None:
        return

    participant_ids = await chat_services.get_chat_participants_ids(db, chat_id)

    await redis_service.send_key_epoch_started(
        redis,
        chat_id=chat_id,
        epoch=epoch.epoch,
        member_set_hash=epoch.member_set_hash,
        reason=epoch.reason.value if hasattr(epoch.reason, "value") else str(epoch.reason),
        recipient_ids=list(participant_ids),
    )


@router.post('/private', response_model=SuccessResponse[ChatResponse])
async def private_chat(
        data: PrivateChatCreateRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    chat = await chat_services.get_or_create_private_chat(db, user.id, data.target_user_id)
    return SuccessResponse(data=chat)


@router.post('/group', response_model=SuccessResponse[ChatResponse])
async def create_group_chat(
        data: GroupChatCreateRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis)
):
    chat = await chat_services.create_group_chat(db, user.id, data)

    await redis_service.send_chat_created_message(redis, chat, user.id, data.participant_ids)

    return SuccessResponse(data=chat)


@router.post('/channel', response_model=SuccessResponse[ChatResponse])
async def create_channel(
        data: ChannelCreateRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis),
):
    """Create a broadcast channel.

    Channels are signed but not encrypted. See the wire spec: confidentiality is unachievable for
    open-enrollment broadcast, and sender-key distribution does not scale to channel membership.
    """
    chat = await chat_services.create_channel(db, user.id, data)

    await redis_service.send_chat_created_message(redis, chat, user.id, data.subscriber_ids)

    return SuccessResponse(data=chat)


@router.get('/', response_model=SuccessResponse[list[ChatResponse]])
async def get_chats(
        limit: int = Query(20, ge=1, le=100),
        offset: int = Query(0, ge=0),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
        mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    chats_from_pg, total_count = await chat_services.get_user_chats(db, user.id, limit, offset)

    if not chats_from_pg:
        return SuccessResponse(
            data=[],
            meta={"total": total_count, "limit": limit, "offset": offset, "has_more": False}
        )

    enriched_chats = await chat_services.enrich_chats_with_mongo_data(
        mongo_db, user.id, chats_from_pg
    )

    meta = {
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "has_more": (offset + limit) < total_count
    }

    return SuccessResponse(data=enriched_chats, meta=meta)


@router.get('/{chat_id}', response_model=SuccessResponse[ChatResponse])
async def get_chat(
        chat_id: uuid.UUID,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    if await messages_service.is_user_in_chat(db, user.id, chat_id) is None:
        raise AppException(403, "ACCESS_DENIED", 'You dont have permission to access this chat.')

    chat = await chat_services.get_chat_by_id(db, chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Chat doesn't exist.")

    return SuccessResponse(data=chat)


@router.get('/{chat_id}/messages', response_model=SuccessResponse[list[MessageResponse]])
async def get_chat_messages(
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        limit: int = Query(50, ge=1, le=100),
        before_id: str | None = Query(None, description="_id of the oldest loaded message."),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
        mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    messages = await messages_service.get_chat_messages(db, mongo_db, user.id, chat_id, limit, before_id)
    return SuccessResponse(data=messages)


@router.post('/{chat_id}/delete-participants', response_model=SuccessResponse[ChatResponse])
async def delete_participants(
        data: UserListRequest, user: User = Depends(get_current_user),
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis),
        mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    chat_p = await messages_service.is_user_in_chat(db, user.id, chat_id)

    if chat_p is None:
        raise AppException(403, "ACCESS_DENIED", 'You dont have permission to access this chat.')

    chat = await chat_services.get_chat_by_id(db, chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Chat doesn't exist.")

    if chat.chat_type == ChatType.PRIVATE:
        raise AppException(400, "INVALID_CHAT_TYPE", 'Participants of a private chat cannot be changed.')

    if chat_p.role == ParticipantRole.MEMBER:
        raise AppException(403, "ACCESS_DENIED", 'You dont have permission to delete participants in this chat.')

    targets = await chat_services.get_participants_by_ids(db, chat_id, data.user_ids)
    actor_rank = chat_services.role_rank(chat_p.role)

    for target in targets:
        if target.user_id == user.id:
            raise AppException(400, "INVALID_TARGET", 'Use the leave endpoint to remove yourself.')

        if chat_services.role_rank(target.role) >= actor_rank:
            raise AppException(403, "ACCESS_DENIED",
                               'You cannot remove a participant with an equal or higher role.')

    _, epoch = await chat_services.delete_chat_participants(
        db, chat_id, data.user_ids, mongo_db=mongo_db
    )
    await _announce_epoch(db, redis, chat_id, epoch)

    chat = await chat_services.get_chat_by_id(db, chat_id)

    return SuccessResponse(data=chat)


@router.post('/{chat_id}/leave', response_model=SuccessResponse[dict])
async def leave_chat(
        user: User = Depends(get_current_user),
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis),
        mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    """Remove yourself from a group or channel.

    Triggers the same mandatory key rotation as being removed by an admin — a departing member
    keeps every key they already held, so the chat must re-key before sending anything else.
    """
    participant = await messages_service.is_user_in_chat(db, user.id, chat_id)
    if participant is None:
        raise AppException(403, "ACCESS_DENIED", 'You are not a participant of this chat.')

    chat = await chat_services.get_chat_by_id(db, chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Chat doesn't exist.")

    if chat.chat_type == ChatType.PRIVATE:
        raise AppException(400, "INVALID_CHAT_TYPE", 'You cannot leave a private chat.')

    if participant.role == ParticipantRole.OWNER:
        raise AppException(
            400, "OWNER_CANNOT_LEAVE",
            'Transfer ownership before leaving, or delete the chat.',
        )

    epoch = await chat_services.leave_chat(db, chat_id, user.id, mongo_db=mongo_db)
    await _announce_epoch(db, redis, chat_id, epoch)

    return SuccessResponse(data={"message": "You have left the chat."})


@router.post('/{chat_id}/add-participants', response_model=SuccessResponse[ChatResponse])
async def add_participants(
        data: UserListRequest, user: User = Depends(get_current_user),
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis),
        mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    chat_p = await messages_service.is_user_in_chat(db, user.id, chat_id)

    if chat_p is None:
        raise AppException(403, "ACCESS_DENIED", 'You dont have permission to access this chat.')

    chat = await chat_services.get_chat_by_id(db, chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Chat doesn't exist.")

    if chat.chat_type == ChatType.PRIVATE:
        raise AppException(400, "INVALID_CHAT_TYPE", 'Participants of a private chat cannot be changed.')

    if chat_p.role == ParticipantRole.MEMBER:
        raise AppException(403, "ACCESS_DENIED", 'You dont have permission to add participants to this chat.')

    _, epoch = await chat_services.add_chat_participants(
        db, chat_id, data.user_ids, mongo_db=mongo_db
    )
    await _announce_epoch(db, redis, chat_id, epoch)

    chat = await chat_services.get_chat_by_id(db, chat_id)

    return SuccessResponse(data=chat)


@router.post('/{chat_id}/change-role', response_model=SuccessResponse[ChatParticipantResponse])
async def change_role(
        data: ChangeRoleRequest, user: User = Depends(get_current_user),
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        db: AsyncSession = Depends(get_db)
):
    chat_p = await messages_service.is_user_in_chat(db, user.id, chat_id)

    if chat_p is None:
        raise AppException(403, "ACCESS_DENIED", 'You dont have permission to access this chat.')

    if await messages_service.is_user_in_chat(db, data.user_id, chat_id) is None:
        raise AppException(400, "USER_NOT_IN_CHAT", 'This user is not in this chat.')

    if chat_p.role != ParticipantRole.OWNER:
        raise AppException(403, "ACCESS_DENIED", 'You dont have permission to change roles in this chat.')

    if data.role == ParticipantRole.OWNER:
        raise AppException(400, "ACCESS_DENIED", 'You cannot give OWNER role to someone.')

    if user.id == data.user_id:
        raise AppException(403, "ACCESS_DENIED", 'You cannot change your role.')

    cp = await chat_services.change_role(db, chat_id, data.user_id, data.role)
    return SuccessResponse(data=cp)
