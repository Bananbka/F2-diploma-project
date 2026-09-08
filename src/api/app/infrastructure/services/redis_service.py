import uuid

from redis.asyncio import Redis

from app.domains.chats.models import Chat
from app.domains.chats.schemas.chat_schemas import ChatResponse
from app.domains.messages.schemas.ws_schemas import WSMessageEnvelope, WSEventType


async def send_key_epoch_started(
        redis: Redis,
        chat_id: uuid.UUID,
        epoch: int,
        member_set_hash: str,
        reason: str,
        recipient_ids: list[uuid.UUID],
):
    """Tell members a new epoch opened so they can publish a chain and fetch grants.

    Delivery is best-effort. Clients must also reconcile on reconnect and on decrypt failure,
    because anyone offline now will simply miss this.
    """
    envelope = WSMessageEnvelope(
        event_type=WSEventType.KEY_EPOCH_STARTED,
        chat_id=chat_id,
        payload={"epoch": epoch, "member_set_hash": member_set_hash, "reason": reason},
    )
    event_json = envelope.model_dump_json()

    for recipient_id in set(recipient_ids):
        await redis.publish(f"user:{recipient_id}", event_json)


async def send_chat_created_message(redis: Redis, chat: Chat, user_id: uuid.UUID, participant_ids: list[uuid.UUID]):
    chat_dict = ChatResponse.model_validate(chat).model_dump(mode='json')

    ws_envelope = WSMessageEnvelope(
        event_type=WSEventType.CHAT_CREATED,
        chat_id=chat.id,
        user_id=user_id,
        payload={
            "message": f"Group '{chat.title}' has been created.",
            "chat": chat_dict
        }
    )
    event_json = ws_envelope.model_dump_json()
    pids = set(participant_ids) | {user_id}

    for user_id in pids:
        await redis.publish(f"user:{user_id}", event_json)
