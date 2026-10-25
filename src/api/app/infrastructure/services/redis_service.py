import time
import uuid


from app.domains.chats.models import Chat
from app.domains.chats.schemas.chat_schemas import ChatResponse
from app.domains.messages.schemas.ws_schemas import WSEventType, WSMessageEnvelope
from app.infrastructure.services.event_publisher import EventPublisher


async def send_key_epoch_started(
    publisher: EventPublisher,
    chat_id: uuid.UUID,
    epoch: int,
    member_set_hash: str,
    reason: str,
    recipient_ids: list[uuid.UUID],
):
    """Tell members a new epoch opened so they can publish a chain and fetch grants.

    Delivery is best-effort: a socket that was offline can replay it from its cursor, but clients
    must still reconcile on decrypt failure.
    """
    envelope = WSMessageEnvelope(
        event_type=WSEventType.KEY_EPOCH_STARTED,
        chat_id=chat_id,
        payload={"epoch": epoch, "member_set_hash": member_set_hash, "reason": reason},
    )
    await publisher.publish_durable(envelope, recipient_ids)


async def publish_session_revoked(publisher: EventPublisher, user_id: uuid.UUID, scope: str) -> None:
    """Tell every open socket of a user that a session was revoked (`scope`: "token" or "all").

    Sockets re-check their own session on receipt, so a logout that revokes one token closes only
    the sockets authenticated with it, while a force_logout closes all of those it covers.
    """
    envelope = WSMessageEnvelope(
        event_type=WSEventType.SESSION_REVOKED,
        user_id=user_id,
        payload={"scope": scope, "revoked_at": time.time()},
    )
    # Ephemeral: replaying a revocation to a later socket would close a perfectly valid session.
    await publisher.publish_ephemeral(envelope, [user_id])


async def _publish(publisher: EventPublisher, envelope: WSMessageEnvelope, recipient_ids) -> None:
    """Fan one envelope out to a set of users.

    Fan-out is per-user, not per-chat: each connection subscribes to `user:{id}` only, so any API
    instance can reach any connected client. That means the publisher always has to resolve
    recipients itself.
    """
    await publisher.publish_durable(envelope, recipient_ids)


async def send_participants_added(
    publisher: EventPublisher,
    chat_id: uuid.UUID,
    added_ids: list[uuid.UUID],
    recipient_ids: list[uuid.UUID],
):
    await _publish(
        publisher,
        WSMessageEnvelope(
            event_type=WSEventType.PARTICIPANTS_ADDED,
            chat_id=chat_id,
            payload={"user_ids": [str(u) for u in added_ids]},
        ),
        recipient_ids,
    )


async def send_participants_removed(
    publisher: EventPublisher,
    chat_id: uuid.UUID,
    removed_ids: list[uuid.UUID],
    recipient_ids: list[uuid.UUID],
):
    """Tell the remaining members who left or was removed.

    The removed members themselves get CHAT_DELETED instead — from their side the chat is simply
    gone, and they must not keep polling a conversation they can no longer read.
    """
    await _publish(
        publisher,
        WSMessageEnvelope(
            event_type=WSEventType.PARTICIPANTS_REMOVED,
            chat_id=chat_id,
            payload={"user_ids": [str(u) for u in removed_ids]},
        ),
        recipient_ids,
    )


async def send_chat_updated(
    publisher: EventPublisher,
    chat_id: uuid.UUID,
    recipient_ids: list[uuid.UUID],
    payload: dict,
):
    await _publish(
        publisher,
        WSMessageEnvelope(
            event_type=WSEventType.CHAT_UPDATED, chat_id=chat_id, payload=payload
        ),
        recipient_ids,
    )


async def send_chat_deleted(
    publisher: EventPublisher, chat_id: uuid.UUID, recipient_ids: list[uuid.UUID]
):
    await _publish(
        publisher,
        WSMessageEnvelope(
            event_type=WSEventType.CHAT_DELETED,
            chat_id=chat_id,
            payload={"chat_id": str(chat_id)},
        ),
        recipient_ids,
    )


async def send_chat_created_message(
    publisher: EventPublisher, chat: Chat, user_id: uuid.UUID, participant_ids: list[uuid.UUID]
):
    chat_dict = ChatResponse.model_validate(chat).model_dump(mode="json")

    ws_envelope = WSMessageEnvelope(
        event_type=WSEventType.CHAT_CREATED,
        chat_id=chat.id,
        user_id=user_id,
        payload={
            "message": f"Group '{chat.title}' has been created.",
            "chat": chat_dict,
        },
    )
    await publisher.publish_durable(ws_envelope, set(participant_ids) | {user_id})
