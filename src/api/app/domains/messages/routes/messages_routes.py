from fastapi import APIRouter, Depends
from fastapi import Path
from motor.motor_asyncio import AsyncIOMotorDatabase
from sqlalchemy.ext.asyncio import AsyncSession
from redis.asyncio import Redis

from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.core.responses import SuccessResponse
from app.domains.chats.services.chat_services import get_chat_participants_ids
from app.domains.messages.schemas.messages_schemas import (
    MessageResponse,
    MessageCreateRequest,
    MessageUpdateRequest,
    ReactionRequest,
    validate_emoji,
)
from app.domains.messages.schemas.ws_schemas import WSMessageEnvelope, WSEventType
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis

router = APIRouter(prefix="/messages", tags=["Messages"])

# Generous enough not to touch normal chat use, but bounded so a compromised or buggy client
# cannot flood a chat or hammer envelope validation. Per user, not per chat, since fan-out already
# resolves per-participant regardless of which chat a burst targets.
MESSAGE_WRITE_WINDOW = 60
MESSAGE_WRITE_LIMIT = 300

# Reacting is cheap and expected to happen far more often than sending, so it gets a higher cap on
# the same window. Pinning is the opposite: rare and restricted to admins/owners already, so it
# gets a much tighter one — mostly to bound a buggy client rather than a malicious one.
REACTION_WRITE_WINDOW = 60
REACTION_WRITE_LIMIT = 600
PIN_WRITE_WINDOW = 60
PIN_WRITE_LIMIT = 60


async def _broadcast(
    redis: Redis, db: AsyncSession, event_type: WSEventType, msg: MessageResponse, user_id
) -> None:
    participant_ids = await get_chat_participants_ids(db, msg.chat_id)
    ws_envelope = WSMessageEnvelope(
        event_type=event_type,
        chat_id=msg.chat_id,
        user_id=user_id,
        payload=msg.model_dump(mode="json", by_alias=True),
    )
    message_json = ws_envelope.model_dump_json()
    for participant_id in participant_ids:
        await redis.publish(f"user:{participant_id}", message_json)


# MESSAGES CRUD
@router.post("/", response_model=SuccessResponse[MessageResponse])
async def create_message(
        message_in: MessageCreateRequest, user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), redis: Redis = Depends(get_redis),
        mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db)
):
    await enforce_rate_limit(
        redis,
        scope="message-send",
        identifier=str(user.id),
        limit=MESSAGE_WRITE_LIMIT,
        window_seconds=MESSAGE_WRITE_WINDOW,
        message="You are sending messages too quickly. Please slow down.",
    )

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
    await enforce_rate_limit(
        redis,
        scope="message-send",
        identifier=str(user.id),
        limit=MESSAGE_WRITE_LIMIT,
        window_seconds=MESSAGE_WRITE_WINDOW,
        message="You are sending messages too quickly. Please slow down.",
    )

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


# REACTIONS
@router.post("/{message_id}/reactions", response_model=SuccessResponse[MessageResponse])
async def react_to_message(
        reaction_in: ReactionRequest,
        message_id: str = Path(..., description="Message ID"), user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
        redis: Redis = Depends(get_redis)
):
    """Toggle the caller's reaction with this emoji.

    Reacting with an emoji the caller already placed on this message removes it again; reacting
    with a different one adds an additional, independent reaction. See
    `messages_service.toggle_reaction` for the reasoning.
    """
    await enforce_rate_limit(
        redis,
        scope="message-reaction",
        identifier=str(user.id),
        limit=REACTION_WRITE_LIMIT,
        window_seconds=REACTION_WRITE_WINDOW,
        message="You are reacting too quickly. Please slow down.",
    )

    msg, added = await messages_service.toggle_reaction(
        db, mongo_db, user.id, message_id, reaction_in.emoji
    )

    await _broadcast(
        redis,
        db,
        WSEventType.MESSAGE_REACTION_ADDED if added else WSEventType.MESSAGE_REACTION_REMOVED,
        msg,
        user.id,
    )

    return SuccessResponse(data=msg)


@router.delete(
    "/{message_id}/reactions/{emoji}", response_model=SuccessResponse[MessageResponse]
)
async def unreact_to_message(
        message_id: str = Path(..., description="Message ID"),
        emoji: str = Path(..., description="The emoji to remove", min_length=1, max_length=8),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
        redis: Redis = Depends(get_redis)
):
    """Explicit removal, distinct from the toggle above and idempotent: removing a reaction that
    was never there is a success, not a 404."""
    try:
        emoji = validate_emoji(emoji)
    except ValueError as exc:
        raise AppException(422, "INVALID_EMOJI", str(exc))

    await enforce_rate_limit(
        redis,
        scope="message-reaction",
        identifier=str(user.id),
        limit=REACTION_WRITE_LIMIT,
        window_seconds=REACTION_WRITE_WINDOW,
        message="You are reacting too quickly. Please slow down.",
    )

    msg = await messages_service.remove_reaction(db, mongo_db, user.id, message_id, emoji)

    await _broadcast(redis, db, WSEventType.MESSAGE_REACTION_REMOVED, msg, user.id)

    return SuccessResponse(data=msg)


# PINNING
@router.post("/{message_id}/pin", response_model=SuccessResponse[MessageResponse])
async def pin_message(
        message_id: str = Path(..., description="Message ID"), user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
        redis: Redis = Depends(get_redis)
):
    """Pin a message. Open to either participant in a private chat; admins and the owner only in
    groups and channels. Idempotent, and bounded by a per-chat cap — see `messages_service.pin_message`."""
    await enforce_rate_limit(
        redis,
        scope="message-pin",
        identifier=str(user.id),
        limit=PIN_WRITE_LIMIT,
        window_seconds=PIN_WRITE_WINDOW,
        message="You are pinning messages too quickly. Please slow down.",
    )

    msg = await messages_service.pin_message(db, mongo_db, user.id, message_id)

    await _broadcast(redis, db, WSEventType.MESSAGE_PINNED, msg, user.id)

    return SuccessResponse(data=msg)


@router.post("/{message_id}/unpin", response_model=SuccessResponse[MessageResponse])
async def unpin_message(
        message_id: str = Path(..., description="Message ID"), user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db), mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
        redis: Redis = Depends(get_redis)
):
    """Unpin a message. Same permission rule as pinning. Idempotent."""
    await enforce_rate_limit(
        redis,
        scope="message-pin",
        identifier=str(user.id),
        limit=PIN_WRITE_LIMIT,
        window_seconds=PIN_WRITE_WINDOW,
        message="You are pinning messages too quickly. Please slow down.",
    )

    msg = await messages_service.unpin_message(db, mongo_db, user.id, message_id)

    await _broadcast(redis, db, WSEventType.MESSAGE_UNPINNED, msg, user.id)

    return SuccessResponse(data=msg)
