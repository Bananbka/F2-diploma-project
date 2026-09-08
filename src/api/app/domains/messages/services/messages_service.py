import uuid
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from motor.motor_asyncio import AsyncIOMotorDatabase
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import AppException
from app.domains.chats.models import ChatParticipant, Chat, ChatType, ParticipantRole
from app.domains.crypto.models import CryptoMode
from app.domains.crypto.reference.channel import verify_channel_post
from app.domains.crypto.reference.envelope import verify_envelope_signature
from app.domains.crypto.reference.primitives import b64u_decode
from app.domains.crypto.services import epoch_service, identity_service
from app.domains.messages.schemas.messages_schemas import (
    ContentFormat,
    MessageCreateRequest,
    MessageDocument,
    MessageResponse,
    MessageUpdateRequest,
)
from app.infrastructure.minio import minio_manager


async def is_user_in_chat(
        db: AsyncSession,
        user_id: uuid.UUID,
        chat_id: uuid.UUID,
) -> ChatParticipant | None:
    stmt = select(ChatParticipant).where(ChatParticipant.user_id == user_id, ChatParticipant.chat_id == chat_id)
    res = await db.execute(stmt)
    return res.scalar_one_or_none()


async def is_user_in_all_chats(
        db: AsyncSession,
        user_id: uuid.UUID,
        chat_ids: list[uuid.UUID]
):
    stmt = select(func.count()).select_from(ChatParticipant).where(ChatParticipant.user_id == user_id,
                                                                   ChatParticipant.chat_id.in_(chat_ids))

    res = await db.execute(stmt)
    cp = res.scalar_one()

    return cp == len(chat_ids)


async def get_chat_or_403(db: AsyncSession, chat_id: uuid.UUID, user_id: uuid.UUID) -> Chat:
    stmt = (
        select(ChatParticipant, Chat)
        .join(Chat, Chat.id == ChatParticipant.chat_id)
        .where(
            ChatParticipant.user_id == user_id,
            ChatParticipant.chat_id == chat_id
        )
    )
    result = await db.execute(stmt)
    row = result.first()

    if not row:
        raise AppException(403, "FORBIDDEN", "You are not a participant of this chat.")

    _, chat = row.ChatParticipant, row.Chat
    return chat


def objectify_id(id_: str) -> ObjectId:
    try:
        return ObjectId(id_)
    except InvalidId:
        raise AppException(400, "INVALID_ID", "Message id is invalid.")


async def get_message_by_id(collection, id_: ObjectId) -> dict:
    msg = await collection.find_one({"_id": id_})
    if not msg:
        raise AppException(404, "NOT_FOUND", "Message not found.")
    return msg


async def get_and_validate_message(db: AsyncSession, collection, msg_id: str, user_id: uuid.UUID):
    obj_id = objectify_id(msg_id)

    msg = await get_message_by_id(collection, obj_id)

    if msg.get("sender_id") != user_id:
        raise AppException(403, "FORBIDDEN", "You are not sender of this message.")

    return msg


def resolve_content_format(doc: dict, chat: Chat) -> ContentFormat:
    """Classify a stored document.

    Documents written before the envelope existed have no content_format, so it is inferred once
    here rather than recomputed inconsistently at each call site.
    """
    stored = doc.get("content_format")
    if stored:
        return ContentFormat(stored)

    if doc.get("envelope"):
        return ContentFormat.SENDER_KEYS_V1

    return (
        ContentFormat.LEGACY_RSA
        if chat.chat_type == ChatType.PRIVATE
        else ContentFormat.LEGACY_PLAINTEXT
    )


async def _validate_envelope(db, chat, user_id, settings, envelope) -> None:
    """Gate the send path on the chat's current epoch.

    The server cannot read the message, but it can refuse to store one that is not keyed to the
    live epoch or that claims a chain nobody published. Both matter after a member is removed: a
    message accepted under the previous epoch would still be readable by them.
    """
    if envelope is None:
        raise AppException(
            400, "ENVELOPE_REQUIRED",
            "This chat is end-to-end encrypted; send an envelope rather than plaintext.",
        )

    # Strict equality, not a grace window. A window is exactly the hole that lets an in-flight
    # message from before a removal land after it.
    if envelope.epoch != settings.current_epoch:
        raise AppException(
            409, "EPOCH_STALE",
            "This chat has re-keyed. Fetch the current epoch, re-encrypt and retry.",
            details={"current_epoch": settings.current_epoch, "sent_epoch": envelope.epoch},
        )

    distribution = await epoch_service.get_distribution(
        db, chat.id, settings.current_epoch, envelope.skid
    )
    if distribution is None:
        raise AppException(
            409, "SENDER_KEY_MISSING",
            "Publish a sender key for the current epoch before sending.",
            details={"current_epoch": settings.current_epoch},
        )

    if distribution.sender_user_id != user_id:
        raise AppException(
            403, "SENDER_KEY_NOT_YOURS",
            "That sender key belongs to another member.",
        )

    # The only integrity check available to a server that cannot read the message: prove the
    # sender is who the envelope claims. Blocks forged-attribution injection at the source.
    if not verify_envelope_signature(
            envelope=envelope.model_dump(mode="json"),
            signing_public=b64u_decode(distribution.signing_public_key),
            chat_id=chat.id,
            sender_id=user_id,
    ):
        raise AppException(
            400, "INVALID_MESSAGE_SIGNATURE",
            "The message signature does not verify against your published sender key.",
        )


async def _validate_channel_post(db, chat, user_id, post) -> None:
    """Gate channel posting on role, and verify the post signature.

    Channels are broadcast: only the owner and admins may post. Verifying the signature server-side
    means a stored post is always one the claimed author actually signed, which is the property
    subscribers rely on given the content itself is not confidential.
    """
    participant = await is_user_in_chat(db, user_id, chat.id)
    if participant is None or participant.role == ParticipantRole.MEMBER:
        raise AppException(
            403, "CHANNEL_POST_FORBIDDEN",
            "Only the channel owner and admins can post.",
        )

    if post is None:
        raise AppException(
            400, "CHANNEL_POST_REQUIRED",
            "Channel messages must be sent as a signed channel_post.",
        )

    identity = await identity_service.get_active_signing_key(db, user_id)
    if identity is None:
        raise AppException(
            400, "NO_IDENTITY_KEY",
            "Publish an identity key before posting; channel posts must be signed.",
        )

    if not verify_channel_post(
            signing_public=b64u_decode(identity.signing_public_key),
            signature=post.sig,
            chat_id=chat.id,
            sender_id=user_id,
            post_id=post.post_id,
            content=post.content,
    ):
        raise AppException(
            400, "INVALID_POST_SIGNATURE",
            "The post signature does not verify against your identity key.",
        )


async def send_message(
        db: AsyncSession,
        mongo_db: AsyncIOMotorDatabase,
        user_id: uuid.UUID,
        message_in: MessageCreateRequest
) -> MessageResponse:
    chat = await get_chat_or_403(db, message_in.chat_id, user_id)

    settings = await epoch_service.get_settings(db, message_in.chat_id)
    is_encrypted_chat = (
        settings is not None and settings.crypto_mode is CryptoMode.SENDER_KEYS_V1
    )

    if chat.chat_type == ChatType.CHANNEL:
        await _validate_channel_post(db, chat, user_id, message_in.channel_post)
        content_format = ContentFormat.CHANNEL_SIGNED_V1
    elif is_encrypted_chat:
        await _validate_envelope(db, chat, user_id, settings, message_in.envelope)
        content_format = ContentFormat.SENDER_KEYS_V1
    elif message_in.envelope is not None:
        content_format = ContentFormat.SENDER_KEYS_V1
    elif chat.chat_type == ChatType.PRIVATE:
        content_format = ContentFormat.LEGACY_RSA
    else:
        content_format = ContentFormat.LEGACY_PLAINTEXT

    new_message = MessageDocument(
        **message_in.model_dump(),
        sender_id=user_id,
        content_format=content_format,
        created_at=datetime.now(timezone.utc),
    )

    # mode="json" so the envelope's UUID and enum members serialise to BSON-safe primitives.
    message_dict = new_message.model_dump(mode="json")
    message_dict["chat_id"] = new_message.chat_id
    message_dict["sender_id"] = new_message.sender_id
    message_dict["created_at"] = new_message.created_at

    collection = mongo_db["messages"]
    res = await collection.insert_one(dict(message_dict))

    message_dict["_id"] = str(res.inserted_id)
    return MessageResponse(**message_dict)


async def get_chat_messages(
        db: AsyncSession,
        mongo_db: AsyncIOMotorDatabase,
        user_id: uuid.UUID,
        chat_id: uuid.UUID,
        limit: int = 50,
        before_id: str | None = None
) -> list[MessageResponse]:
    chat = await get_chat_or_403(db, chat_id, user_id)

    collection = mongo_db["messages"]
    query = {"chat_id": chat_id}

    if before_id:
        message_id = objectify_id(before_id)
        query["_id"] = {"$lt": message_id}

    # Floor history at the point this member joined. They hold no keys for earlier epochs, so this
    # is not the confidentiality boundary — but without it they still receive every historical
    # ciphertext, which leaks sender, timing, size and reply structure for the whole history.
    participant = await is_user_in_chat(db, user_id, chat_id)
    if participant is not None and participant.history_start_message_id:
        floor = objectify_id(participant.history_start_message_id)
        query["_id"] = {**query.get("_id", {}), "$gt": floor}

    crs = (
        collection
        .find(query)
        .sort("_id", -1)
        .limit(limit)
    )
    messages = await crs.to_list(length=limit)

    res = []
    for msg in messages:
        msg["_id"] = str(msg["_id"])
        msg["content_format"] = resolve_content_format(msg, chat)
        res.append(MessageResponse(**msg))

    return res


async def update_message(
        db: AsyncSession,
        mongo_db: AsyncIOMotorDatabase,
        user_id: uuid.UUID,
        msg_id: str,
        message_in: MessageUpdateRequest,
) -> MessageResponse:
    collection = mongo_db["messages"]

    msg = await get_and_validate_message(db, collection, msg_id, user_id)
    obj_id = msg["_id"]

    chat_id = msg.get("chat_id")
    chat = await get_chat_or_403(db, chat_id, user_id)

    if message_in.envelope is not None:
        existing = msg.get("envelope")

        # An index only means anything within one chain. A message key is derived from its chain key,
        # and every sender_key_id has its own random chain key, so index 0 of a new chain is a
        # different key from index 0 of the old one — no (key, nonce) pair is repeated.
        #
        # Scoping the check to a matching chain is not a relaxation, it is what makes it correct.
        # Comparing bare indices used to work only because a device could publish one chain per epoch;
        # since that constraint was lifted, a client whose in-memory chain is gone mints a fresh one
        # starting at 0, and every edit after a reload was rejected out of hand.
        same_chain = (
            existing
            and str(existing.get("skid")) == str(message_in.envelope.skid)
            and existing.get("epoch") == message_in.envelope.epoch
        )

        if same_chain and message_in.envelope.idx <= existing.get("idx", -1):
            raise AppException(
                400, "CHAIN_INDEX_REUSED",
                "An edit must use a fresh chain index; reusing one would repeat a message key.",
            )

        update = {
            "envelope": message_in.envelope.model_dump(mode="json"),
            "encrypted_content": None,
            "content_format": ContentFormat.SENDER_KEYS_V1.value,
            "is_edited": True,
        }
    else:
        update = {"encrypted_content": message_in.encrypted_content, "is_edited": True}

    await collection.update_one({"_id": obj_id}, {"$set": update})

    upd_msg = await collection.find_one({"_id": obj_id})
    upd_msg["_id"] = str(obj_id)
    upd_msg["content_format"] = resolve_content_format(upd_msg, chat)

    return MessageResponse(**upd_msg)


async def delete_message(
        db: AsyncSession,
        mongo_db: AsyncIOMotorDatabase,
        user_id: uuid.UUID,
        msg_id: str,
) -> uuid.UUID:
    collection = mongo_db["messages"]
    msg = await get_and_validate_message(db, collection, msg_id, user_id)

    await collection.delete_one({"_id": msg["_id"]})

    # Only reap a blob once no surviving message references it. A user can name any url in their
    # own message's attachments, so deleting purely on the strength of this document would let
    # them destroy other users' files.
    for attachment in msg.get("attachments") or []:
        file_url = attachment.get("url")
        if not file_url:
            continue

        still_referenced = await collection.find_one({"attachments.url": file_url}, {"_id": 1})
        if still_referenced:
            continue

        await minio_manager.delete_file(file_url, settings.MINIO_MESSAGE_BUCKET)

    return msg["chat_id"]


async def mark_messages_as_read(
        mongo_db: AsyncIOMotorDatabase,
        chat_id: uuid.UUID,
        user_id: uuid.UUID,
        last_read_message_id: str
) -> int:
    collection = mongo_db["messages"]

    message_id = objectify_id(last_read_message_id)

    result = await collection.update_many(
        {
            "chat_id": chat_id,
            "sender_id": {"$ne": user_id},
            "is_read": False,
            "_id": {"$lte": message_id}
        },
        {"$set": {"is_read": True}}
    )

    return result.modified_count
