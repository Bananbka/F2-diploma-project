import uuid
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from motor.motor_asyncio import AsyncIOMotorDatabase
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import AppException
from app.domains.chats.models import Chat, ChatParticipant, ChatType, ParticipantRole
from app.domains.chats.services import chat_services
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

# Many messengers cap simultaneous pins (Telegram allows unlimited but most others bound it); a
# small cap keeps the pinned list actually skimmable and bounds the size of the listing query.
MAX_PINNED_MESSAGES_PER_CHAT = 5


async def is_user_in_chat(
    db: AsyncSession,
    user_id: uuid.UUID,
    chat_id: uuid.UUID,
) -> ChatParticipant | None:
    stmt = select(ChatParticipant).where(
        ChatParticipant.user_id == user_id, ChatParticipant.chat_id == chat_id
    )
    res = await db.execute(stmt)
    return res.scalar_one_or_none()


async def is_user_in_all_chats(
    db: AsyncSession, user_id: uuid.UUID, chat_ids: list[uuid.UUID]
):
    stmt = (
        select(func.count())
        .select_from(ChatParticipant)
        .where(
            ChatParticipant.user_id == user_id, ChatParticipant.chat_id.in_(chat_ids)
        )
    )

    res = await db.execute(stmt)
    cp = res.scalar_one()

    return cp == len(chat_ids)


async def get_chat_or_403(
    db: AsyncSession, chat_id: uuid.UUID, user_id: uuid.UUID
) -> Chat:
    stmt = (
        select(ChatParticipant, Chat)
        .join(Chat, Chat.id == ChatParticipant.chat_id)
        .where(ChatParticipant.user_id == user_id, ChatParticipant.chat_id == chat_id)
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


async def get_and_validate_message(
    db: AsyncSession, collection, msg_id: str, user_id: uuid.UUID
):
    obj_id = objectify_id(msg_id)

    msg = await get_message_by_id(collection, obj_id)

    if msg.get("sender_id") != user_id:
        raise AppException(403, "FORBIDDEN", "You are not sender of this message.")

    return msg


async def get_message_for_participant(
    db: AsyncSession, collection, msg_id: str, user_id: uuid.UUID
) -> tuple[dict, Chat]:
    """Look up a message and authorise the caller as a chat participant, not necessarily its sender.

    Reactions and pins are actions any member may take on any message in a chat they belong to,
    unlike edit/delete which `get_and_validate_message` restricts to the sender. This still goes
    through the mandatory `get_chat_or_403` chokepoint before anything in Mongo is written.
    """
    obj_id = objectify_id(msg_id)
    msg = await get_message_by_id(collection, obj_id)

    chat = await get_chat_or_403(db, msg["chat_id"], user_id)
    return msg, chat


async def _authorize_pin_action(db: AsyncSession, chat: Chat, user_id: uuid.UUID) -> None:
    """Gate pin/unpin on role, except in private chats.

    A private chat has exactly two participants, both stored with role MEMBER — there is no admin
    to defer to, and both sides are equal parties to the conversation, so either may pin. In groups
    and channels, pinning is a moderation action visible to everyone in a shared space, so it is
    restricted to admins and the owner, matching the convention most messengers use.
    """
    if chat.chat_type == ChatType.PRIVATE:
        return

    participant = await is_user_in_chat(db, user_id, chat.id)
    if participant is None or chat_services.role_rank(
        participant.role
    ) < chat_services.role_rank(ParticipantRole.ADMIN):
        raise AppException(
            403,
            "PIN_FORBIDDEN",
            "Only admins and the owner can pin messages in this chat.",
        )


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
            400,
            "ENVELOPE_REQUIRED",
            "This chat is end-to-end encrypted; send an envelope rather than plaintext.",
        )

    # Strict equality, not a grace window. A window is exactly the hole that lets an in-flight
    # message from before a removal land after it.
    if envelope.epoch != settings.current_epoch:
        raise AppException(
            409,
            "EPOCH_STALE",
            "This chat has re-keyed. Fetch the current epoch, re-encrypt and retry.",
            details={
                "current_epoch": settings.current_epoch,
                "sent_epoch": envelope.epoch,
            },
        )

    distribution = await epoch_service.get_distribution(
        db, chat.id, settings.current_epoch, envelope.skid
    )
    if distribution is None:
        raise AppException(
            409,
            "SENDER_KEY_MISSING",
            "Publish a sender key for the current epoch before sending.",
            details={"current_epoch": settings.current_epoch},
        )

    if distribution.sender_user_id != user_id:
        raise AppException(
            403,
            "SENDER_KEY_NOT_YOURS",
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
            400,
            "INVALID_MESSAGE_SIGNATURE",
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
            403,
            "CHANNEL_POST_FORBIDDEN",
            "Only the channel owner and admins can post.",
        )

    if post is None:
        raise AppException(
            400,
            "CHANNEL_POST_REQUIRED",
            "Channel messages must be sent as a signed channel_post.",
        )

    identities = await identity_service.get_active_signing_keys(db, user_id)
    if not identities:
        raise AppException(
            400,
            "NO_IDENTITY_KEY",
            "Publish an identity key before posting; channel posts must be signed.",
        )

    # Any active device of this user may have signed it. Checking against one arbitrarily chosen
    # key rejected genuine posts from a user's second device.
    signed_by_this_user = any(
        verify_channel_post(
            signing_public=b64u_decode(identity.signing_public_key),
            signature=post.sig,
            chat_id=chat.id,
            sender_id=user_id,
            post_id=post.post_id,
            content=post.content,
        )
        for identity in identities
    )

    if not signed_by_this_user:
        raise AppException(
            400,
            "INVALID_POST_SIGNATURE",
            "The post signature does not verify against any of your identity keys.",
        )


async def _authorize_attachments(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    attachments,
) -> None:
    """Check the sender is entitled to reference each attachment url.

    The url on a message is client-supplied, and `download_attachment` authorises a read by asking
    whether the object is referenced by a message in a chat you belong to. Those two facts
    combined were a hole: name an object key you happen to know — one from a group you were
    removed from, say — in a message in your own chat, and you had just re-authorised yourself to
    fetch it.

    An attachment is acceptable on exactly two grounds:

      * you uploaded it, or
      * it is already referenced by a message in a chat you are currently in, which is what makes
        forwarding a message with attachments work — a forward is a re-send of the same object.

    A user removed from a chat satisfies neither, which is the case that mattered.
    """
    if not attachments:
        return

    prefix = f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/"
    collection = mongo_db["messages"]

    # Resolved at most once, and only if some attachment is not the caller's own upload. Fetching
    # it per attachment repeated the same query for every file on the message.
    my_chat_ids: list[uuid.UUID] | None = None

    for attachment in attachments:
        url = attachment.url
        object_key = url[len(prefix) :]

        exists, owner = await minio_manager.get_object_owner(
            object_key, settings.MINIO_MESSAGE_BUCKET
        )
        if not exists:
            raise AppException(
                400, "ATTACHMENT_UNKNOWN", "That attachment no longer exists."
            )

        if owner == str(user_id):
            continue

        # `owner is None` means the object predates ownership being recorded. Those fall through
        # to the visibility check below rather than being rejected outright — it is the same
        # question, just answered from the message history instead of from object metadata.
        if my_chat_ids is None:
            my_chat_ids = list(
                (
                    await db.execute(
                        select(ChatParticipant.chat_id).where(
                            ChatParticipant.user_id == user_id
                        )
                    )
                )
                .scalars()
                .all()
            )

        visible = await collection.find_one(
            {"chat_id": {"$in": my_chat_ids}, "attachments.url": url}, {"_id": 1}
        )
        if visible is None:
            raise AppException(
                403,
                "ATTACHMENT_FORBIDDEN",
                "You cannot attach a file you did not upload and cannot currently see.",
            )


async def send_message(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    message_in: MessageCreateRequest,
) -> MessageResponse:
    chat = await get_chat_or_403(db, message_in.chat_id, user_id)

    await _authorize_attachments(db, mongo_db, user_id, message_in.attachments)

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

    # Move the chat to the top of the sender's and every recipient's list. `get_user_chats` has
    # always ordered by this column and nothing ever wrote to it.
    await chat_services.touch_chat(db, message_in.chat_id)
    await db.commit()

    message_dict["_id"] = str(res.inserted_id)
    return MessageResponse(**message_dict)


async def get_chat_messages(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    chat_id: uuid.UUID,
    limit: int = 50,
    before_id: str | None = None,
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

    crs = collection.find(query).sort("_id", -1).limit(limit)
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

    chat_settings = await epoch_service.get_settings(db, chat_id)
    is_encrypted_chat = (
        chat_settings is not None
        and chat_settings.crypto_mode is CryptoMode.SENDER_KEYS_V1
    )

    # A channel post is signed over its own content, so replacing that content through the edit
    # path would leave a document whose stored signature covers something else entirely — an
    # "authenticated" post nobody actually authored. Editing a broadcast post is not supported.
    if chat.chat_type == ChatType.CHANNEL:
        raise AppException(
            400,
            "CHANNEL_POST_NOT_EDITABLE",
            "Channel posts cannot be edited; delete the post and publish a new one.",
        )

    # The send path gates every envelope on the live epoch, on owning the sender key it names, and
    # on the signature verifying. None of that ran here, so an edit was a complete bypass: a member
    # could re-seal under a superseded epoch — readable by whoever was just removed — claim another
    # member's chain, or attach a signature that verifies against nothing.
    if is_encrypted_chat:
        await _validate_envelope(db, chat, user_id, chat_settings, message_in.envelope)
    elif message_in.envelope is not None and chat_settings is not None:
        raise AppException(
            400,
            "ENVELOPE_NOT_ALLOWED",
            "This chat is not end-to-end encrypted; an envelope cannot be verified here.",
        )

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
                400,
                "CHAIN_INDEX_REUSED",
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

        still_referenced = await collection.find_one(
            {"attachments.url": file_url}, {"_id": 1}
        )
        if still_referenced:
            continue

        await minio_manager.delete_file(file_url, settings.MINIO_MESSAGE_BUCKET)

    return msg["chat_id"]


async def mark_messages_as_read(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    chat_id: uuid.UUID,
    user_id: uuid.UUID,
    last_read_message_id: str,
) -> int:
    """Mark everything up to `last_read_message_id` as read for this chat.

    Takes `db` purely to authorise. Mongo carries no ownership information of its own, so a write
    that reaches it without a Postgres membership check is unauthorised by construction — and this
    one is reachable from the WebSocket, where `chat_id` arrives straight from the client.
    """
    if await is_user_in_chat(db, user_id, chat_id) is None:
        raise AppException(403, "FORBIDDEN", "You are not a participant of this chat.")

    collection = mongo_db["messages"]

    message_id = objectify_id(last_read_message_id)

    result = await collection.update_many(
        {
            "chat_id": chat_id,
            "sender_id": {"$ne": user_id},
            "is_read": False,
            "_id": {"$lte": message_id},
        },
        {"$set": {"is_read": True}},
    )

    return result.modified_count


async def toggle_reaction(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    msg_id: str,
    emoji: str,
) -> tuple[MessageResponse, bool]:
    """Add or remove the caller's reaction with this emoji on a message.

    One reaction per (user, message, emoji): reacting with an emoji you already placed on that
    message removes it again — a toggle, the behaviour Telegram and Discord both use — while
    reacting with a *different* emoji adds an additional, independent reaction rather than
    replacing the first. Returns whether the reaction was added (True) or removed (False), so the
    caller can pick the right WS event.

    Atomic by construction rather than read-then-decide-then-write: a `$pull` is attempted first,
    and only if it removed nothing (`modified_count == 0`, meaning the caller had not reacted with
    this emoji) does a `$push` follow — and that `$push`'s own filter re-checks non-existence of the
    same `(user_id, emoji)` pair in the same round trip, so it cannot land twice even if two
    identical requests both fall through to it concurrently. This closes the double-tap race where
    two near-simultaneous toggles could otherwise both read "not reacted yet" and both append,
    leaving a duplicate entry that only a later toggle's `$pull` (which removes every match) would
    clean up.
    """
    collection = mongo_db["messages"]
    msg, chat = await get_message_for_participant(db, collection, msg_id, user_id)

    pull_result = await collection.update_one(
        {"_id": msg["_id"]},
        {"$pull": {"reactions": {"user_id": user_id, "emoji": emoji}}},
    )

    if pull_result.modified_count > 0:
        added = False
    else:
        await collection.update_one(
            {
                "_id": msg["_id"],
                "reactions": {"$not": {"$elemMatch": {"user_id": user_id, "emoji": emoji}}},
            },
            {
                "$push": {
                    "reactions": {
                        "user_id": user_id,
                        "emoji": emoji,
                        "created_at": datetime.now(timezone.utc),
                    }
                }
            },
        )
        # If the filter matched nothing, a concurrent request already added this exact
        # (user_id, emoji) pair between our `$pull` and this `$push` — the reaction is present
        # either way, so this call still reports it as added rather than erroring or no-op'ing
        # into a stale "removed" state.
        added = True

    updated = await collection.find_one({"_id": msg["_id"]})
    updated["_id"] = str(updated["_id"])
    updated["content_format"] = resolve_content_format(updated, chat)

    return MessageResponse(**updated), added


async def remove_reaction(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    msg_id: str,
    emoji: str,
) -> MessageResponse:
    """Explicit removal, distinct from the toggle above. Idempotent: a no-op if the caller had not
    reacted with that emoji, so a client retrying a request that already succeeded is not punished
    with an error."""
    collection = mongo_db["messages"]
    msg, chat = await get_message_for_participant(db, collection, msg_id, user_id)

    await collection.update_one(
        {"_id": msg["_id"]},
        {"$pull": {"reactions": {"user_id": user_id, "emoji": emoji}}},
    )

    updated = await collection.find_one({"_id": msg["_id"]})
    updated["_id"] = str(updated["_id"])
    updated["content_format"] = resolve_content_format(updated, chat)

    return MessageResponse(**updated)


async def pin_message(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    msg_id: str,
) -> MessageResponse:
    """Pin a message, subject to role (see `_authorize_pin_action`) and the per-chat pin cap.

    Idempotent if already pinned — pinning an already-pinned message does not touch `pinned_at` or
    `pinned_by` again and does not count against the cap a second time.
    """
    collection = mongo_db["messages"]
    msg, chat = await get_message_for_participant(db, collection, msg_id, user_id)
    await _authorize_pin_action(db, chat, user_id)

    if not msg.get("is_pinned"):
        pinned_count = await collection.count_documents(
            {"chat_id": chat.id, "is_pinned": True}
        )
        if pinned_count >= MAX_PINNED_MESSAGES_PER_CHAT:
            raise AppException(
                400,
                "PIN_LIMIT_REACHED",
                f"At most {MAX_PINNED_MESSAGES_PER_CHAT} messages may be pinned in a chat at "
                f"once; unpin one before pinning another.",
            )

        await collection.update_one(
            {"_id": msg["_id"]},
            {
                "$set": {
                    "is_pinned": True,
                    "pinned_at": datetime.now(timezone.utc),
                    "pinned_by": user_id,
                }
            },
        )

    updated = await collection.find_one({"_id": msg["_id"]})
    updated["_id"] = str(updated["_id"])
    updated["content_format"] = resolve_content_format(updated, chat)

    return MessageResponse(**updated)


async def unpin_message(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    msg_id: str,
) -> MessageResponse:
    """Unpin a message. Idempotent: unpinning an unpinned message is a no-op, not an error."""
    collection = mongo_db["messages"]
    msg, chat = await get_message_for_participant(db, collection, msg_id, user_id)
    await _authorize_pin_action(db, chat, user_id)

    await collection.update_one(
        {"_id": msg["_id"]},
        {"$set": {"is_pinned": False, "pinned_at": None, "pinned_by": None}},
    )

    updated = await collection.find_one({"_id": msg["_id"]})
    updated["_id"] = str(updated["_id"])
    updated["content_format"] = resolve_content_format(updated, chat)

    return MessageResponse(**updated)


async def get_pinned_messages(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    user_id: uuid.UUID,
    chat_id: uuid.UUID,
) -> list[MessageResponse]:
    chat = await get_chat_or_403(db, chat_id, user_id)

    collection = mongo_db["messages"]
    query: dict = {"chat_id": chat_id, "is_pinned": True}

    # Same history floor as `get_chat_messages`: a member holds no keys for messages pinned before
    # they joined, so those must not surface even as an unreadable pinned entry.
    participant = await is_user_in_chat(db, user_id, chat_id)
    if participant is not None and participant.history_start_message_id:
        query["_id"] = {"$gt": objectify_id(participant.history_start_message_id)}

    crs = collection.find(query).sort("_id", -1).limit(MAX_PINNED_MESSAGES_PER_CHAT)
    messages = await crs.to_list(length=MAX_PINNED_MESSAGES_PER_CHAT)

    res = []
    for msg in messages:
        msg["_id"] = str(msg["_id"])
        msg["content_format"] = resolve_content_format(msg, chat)
        res.append(MessageResponse(**msg))

    return res
