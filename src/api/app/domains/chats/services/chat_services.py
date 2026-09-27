import uuid

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from sqlalchemy import Integer, and_, delete, func, insert, select, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.core.exceptions import AppException
from app.domains.chats.models import (
    Chat,
    ChatParticipant,
    ChatType,
    Contact,
    ParticipantRole,
)
from app.domains.chats.schemas.chat_schemas import GroupChatCreateRequest
from app.domains.crypto.models import (
    ChatCryptoSettings,
    ChatKeyEpoch,
    CryptoMode,
    EpochReason,
)
from app.domains.crypto.services import epoch_service
from app.domains.users.services.user_service import get_user_by_id


async def get_or_create_private_chat(
    db: AsyncSession, current_user_id: uuid.UUID, target_user_id: uuid.UUID
) -> Chat:
    if current_user_id == target_user_id:
        raise AppException(
            400, "INVALID_TARGET", "You cannot create chat with yourself"
        )

    target_user = await get_user_by_id(db, target_user_id)
    if not target_user or not target_user.is_active:
        raise AppException(400, "INVALID_TARGET", "User does not exist")

    # Serialise on the unordered pair, so two people opening a chat with each other at the same
    # moment cannot both miss the lookup below and each create their own. There is no unique
    # constraint that could express "one private chat per pair" across two participant rows.
    pair = "|".join(sorted([str(current_user_id), str(target_user_id)]))
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(pair))))

    stmt = (
        select(Chat)
        .join(ChatParticipant, Chat.id == ChatParticipant.chat_id)
        .where(Chat.chat_type == ChatType.PRIVATE)
        .group_by(Chat.id)
        .having(func.count(ChatParticipant.chat_id) == 2)
        .having(
            func.sum((ChatParticipant.user_id == current_user_id).cast(Integer)) > 0
        )
        .having(func.sum((ChatParticipant.user_id == target_user_id).cast(Integer)) > 0)
        .options(selectinload(Chat.participants))
    )

    result = await db.execute(stmt)
    chat = result.scalar_one_or_none()

    if chat:
        return chat

    new_chat = Chat(chat_type=ChatType.PRIVATE)
    db.add(new_chat)
    await db.flush()

    prt1 = ChatParticipant(
        chat_id=new_chat.id, user_id=current_user_id, role=ParticipantRole.MEMBER
    )
    prt2 = ChatParticipant(
        chat_id=new_chat.id, user_id=target_user_id, role=ParticipantRole.MEMBER
    )

    db.add_all([prt1, prt2])
    await db.commit()

    await db.refresh(new_chat, ["participants"])
    return new_chat


async def create_group_chat(
    db: AsyncSession, user_id: uuid.UUID, data: GroupChatCreateRequest
) -> Chat:
    new_chat = Chat(
        **data.model_dump(exclude={"participant_ids"}), chat_type=ChatType.GROUP
    )
    db.add(new_chat)
    await db.flush()

    participant_ids = set(data.participant_ids) - {user_id}
    cp_to_create = [
        {"chat_id": new_chat.id, "user_id": pid, "role": ParticipantRole.MEMBER}
        for pid in participant_ids
    ]
    cp_to_create.append(
        {"chat_id": new_chat.id, "user_id": user_id, "role": ParticipantRole.OWNER}
    )

    await db.execute(insert(ChatParticipant), cp_to_create)
    await db.commit()

    await db.refresh(new_chat, ["participants"])
    return new_chat


async def create_channel(
    db: AsyncSession,
    user_id: uuid.UUID,
    data,
) -> Chat:
    """Create a broadcast channel.

    Channels get crypto settings with mode NOT_ENCRYPTED rather than no settings row at all, so
    the choice is explicit and auditable rather than an absence. Subscribers join as MEMBER, which
    is the role the send path gates posting on.
    """
    new_chat = Chat(
        **data.model_dump(exclude={"subscriber_ids"}),
        chat_type=ChatType.CHANNEL,
    )
    db.add(new_chat)
    await db.flush()

    subscriber_ids = set(data.subscriber_ids) - {user_id}
    participants = [
        {"chat_id": new_chat.id, "user_id": pid, "role": ParticipantRole.MEMBER}
        for pid in subscriber_ids
    ]
    participants.append(
        {"chat_id": new_chat.id, "user_id": user_id, "role": ParticipantRole.OWNER}
    )

    await db.execute(insert(ChatParticipant), participants)

    db.add(
        ChatCryptoSettings(chat_id=new_chat.id, crypto_mode=CryptoMode.NOT_ENCRYPTED)
    )

    await db.commit()
    await db.refresh(new_chat, ["participants"])
    return new_chat


async def get_user_chats(
    db: AsyncSession, user_id: uuid.UUID, limit: int = 20, offset: int = 0
) -> tuple[list, int]:
    count_stmt = (
        select(func.count())
        .select_from(ChatParticipant)
        .where(ChatParticipant.user_id == user_id)
    )
    total_count = await db.scalar(count_stmt)

    if total_count == 0:
        return [], 0

    me = aliased(ChatParticipant)
    other = aliased(ChatParticipant)

    stmt = (
        select(Chat, me.last_read_message_id, Contact.alias_name.label("partner_alias"))
        .join(me, and_(Chat.id == me.chat_id, me.user_id == user_id))
        # Restricted to PRIVATE. The counterpart join exists only to resolve the other party in a
        # two-person chat, but it was unrestricted, so a group of N produced N-1 rows for the same
        # chat: the list showed groups repeated once per member, and limit/offset paged over those
        # duplicates instead of over chats.
        .outerjoin(
            other,
            and_(
                Chat.id == other.chat_id,
                other.user_id != user_id,
                Chat.chat_type == ChatType.PRIVATE,
            ),
        )
        .outerjoin(
            Contact,
            and_(Contact.owner_id == user_id, Contact.contact_id == other.user_id),
        )
        .options(selectinload(Chat.participants).selectinload(ChatParticipant.user))
        # `updated_at` is null until something updates the row, and NULLs sort first under DESC in
        # Postgres — so brand-new chats outranked active ones. coalesce falls back to creation.
        .order_by(func.coalesce(Chat.updated_at, Chat.created_at).desc(), Chat.id)
        .limit(limit)
        .offset(offset)
    )

    res = await db.execute(stmt)

    chats = []
    for row in res.all():
        chat = row.Chat
        chat.last_read_message_id = row.last_read_message_id
        chat.partner_alias = row.partner_alias
        chats.append(chat)

    return chats, total_count


async def touch_chat(db: AsyncSession, chat_id: uuid.UUID) -> int:
    """Bump a chat's `updated_at` so it sorts to the top of the chat list.

    This existed as `update_chat_updated_at` and had no callers anywhere, while `get_user_chats`
    ordered by the column it was supposed to maintain. The column is `onupdate` only and starts
    null, so in practice the chat list was ordered by nothing at all and new messages never moved
    a conversation.

    Does not commit: the caller owns the transaction, and this must not be able to half-apply
    alongside the write that triggered it.
    """
    res = await db.execute(
        update(Chat).where(Chat.id == chat_id).values(updated_at=func.now())
    )
    return res.rowcount


async def get_chat_participants_ids(db: AsyncSession, chat_id: uuid.UUID):
    stmt = select(ChatParticipant.user_id).where(ChatParticipant.chat_id == chat_id)
    res = await db.execute(stmt)

    return res.scalars().all()


async def update_participant_last_read(
    db: AsyncSession, chat_id: uuid.UUID, user_id: uuid.UUID, last_read_message_id: str
):
    stmt = (
        update(ChatParticipant)
        .where(
            ChatParticipant.chat_id == chat_id,
            ChatParticipant.user_id == user_id,
        )
        .values(last_read_message_id=last_read_message_id)
    )

    await db.execute(stmt)
    await db.commit()


async def get_chat_participants_by_user(db: AsyncSession, user_id: uuid.UUID):
    stmt = select(ChatParticipant).where(ChatParticipant.user_id == user_id)
    res = await db.execute(stmt)
    return res.scalars().all()


async def enrich_chats_with_mongo_data(
    mongo_db: AsyncIOMotorDatabase, user_id: uuid.UUID, pg_chats: list
) -> list[dict]:
    chat_ids = [chat.id for chat in pg_chats]

    unread_branches = []
    for chat in pg_chats:
        chat_match = {"$eq": ["$chat_id", chat.id]}
        sender_match = {"$ne": ["$sender_id", user_id]}

        if getattr(chat, "last_read_message_id", None) and ObjectId.is_valid(
            chat.last_read_message_id
        ):
            read_match = {"$gt": ["$_id", ObjectId(chat.last_read_message_id)]}
            is_unread = {"$and": [chat_match, sender_match, read_match]}
        else:
            is_unread = {"$and": [chat_match, sender_match]}

        unread_branches.append({"case": is_unread, "then": 1})

    pipeline = [
        {"$match": {"chat_id": {"$in": chat_ids}}},
        {"$sort": {"_id": -1}},
        {
            "$group": {
                "_id": "$chat_id",
                "last_message": {"$first": "$$ROOT"},
                "unread_count": {
                    "$sum": {"$switch": {"branches": unread_branches, "default": 0}}
                },
            }
        },
    ]

    collection = mongo_db["messages"]
    aggregated_data = await collection.aggregate(pipeline).to_list(None)

    mongo_dict = {doc["_id"]: doc for doc in aggregated_data}

    result = []
    for chat in pg_chats:
        stats = mongo_dict.get(chat.id, {"unread_count": 0, "last_message": None})

        last_msg = stats["last_message"]
        if last_msg and "_id" in last_msg:
            last_msg["_id"] = str(last_msg["_id"])

        display_name = chat.title
        partner_avatar = chat.avatar_url
        if chat.chat_type == ChatType.PRIVATE:
            partner = next(
                (p.user for p in chat.participants if p.user_id != user_id), None
            )

            if partner:
                partner_avatar = partner.avatar_url
                display_name = getattr(chat, "partner_alias", None) or partner.full_name

        result.append(
            {
                "id": chat.id,
                "title": display_name,
                "avatar_url": partner_avatar,
                "chat_type": chat.chat_type,
                "unread_count": stats["unread_count"],
                "last_message": last_msg,
                "created_at": chat.created_at,
                "updated_at": chat.updated_at,
            }
        )

    return result


async def get_chat_by_id(db, chat_id: uuid.UUID) -> Chat | None:
    stmt = (
        select(Chat).where(Chat.id == chat_id).options(selectinload(Chat.participants))
    )
    res = await db.execute(stmt)

    return res.scalar_one_or_none()


ROLE_RANK = {
    ParticipantRole.OWNER: 3,
    ParticipantRole.ADMIN: 2,
    ParticipantRole.MEMBER: 1,
}


def role_rank(role: ParticipantRole) -> int:
    return ROLE_RANK[role]


async def get_participants_by_ids(
    db: AsyncSession, chat_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> list[ChatParticipant]:
    stmt = select(ChatParticipant).where(
        ChatParticipant.chat_id == chat_id, ChatParticipant.user_id.in_(user_ids)
    )
    res = await db.execute(stmt)
    return list(res.scalars().all())


async def delete_chat_participants(
    db: AsyncSession,
    chat_id: uuid.UUID,
    user_ids: list[uuid.UUID],
    mongo_db=None,
) -> tuple[int, "ChatKeyEpoch | None"]:
    """Remove participants, rotating the chat's key epoch in the same transaction.

    Rotation on removal is mandatory and must be atomic with the removal itself: the departed
    member keeps every key they already held, so anything sent under the old epoch after they left
    would still be readable by them.
    """
    stmt = delete(ChatParticipant).where(
        ChatParticipant.chat_id == chat_id, ChatParticipant.user_id.in_(user_ids)
    )
    res = await db.execute(stmt)

    epoch = await epoch_service.rotate_if_encrypted(
        db, chat_id, EpochReason.MEMBER_REMOVED, mongo_db=mongo_db
    )

    await db.commit()
    return res.rowcount, epoch


async def add_chat_participants(
    db: AsyncSession,
    chat_id: uuid.UUID,
    user_ids: list[uuid.UUID],
    mongo_db=None,
) -> tuple[int, "ChatKeyEpoch | None"]:
    """Add participants, enforcing the encrypted-group member cap when the chat is encrypted.

    `enable_encryption` only checks the cap at the moment encryption is turned on — nothing stopped
    an owner from enabling it at 5 members and then adding past `MAX_E2E_GROUP_MEMBERS` afterwards,
    which breaks the sender-key cost invariant (`S x (N-1)` grants per epoch) the cap exists to
    bound. Only encrypted chats are capped; plain groups have no such limit.

    The count-then-insert below is check-then-act, so it takes `FOR UPDATE` on the chat's crypto
    settings row first: a second concurrent call for the same chat blocks until the first commits,
    at which point its `count()` observes the first call's inserts. Without the lock, two concurrent
    calls near the cap could both read the same count, both pass, and both commit, overshooting it.
    """
    crypto_settings = (
        await db.execute(
            select(ChatCryptoSettings)
            .where(ChatCryptoSettings.chat_id == chat_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if (
        crypto_settings is not None
        and crypto_settings.crypto_mode == CryptoMode.SENDER_KEYS_V1
    ):
        current_count = await db.scalar(
            select(func.count())
            .select_from(ChatParticipant)
            .where(ChatParticipant.chat_id == chat_id)
        )
        already_in = set(
            (
                await db.execute(
                    select(ChatParticipant.user_id).where(
                        ChatParticipant.chat_id == chat_id,
                        ChatParticipant.user_id.in_(user_ids),
                    )
                )
            ).scalars()
        )
        joining = len(set(user_ids) - already_in)

        if current_count + joining > epoch_service.MAX_E2E_GROUP_MEMBERS:
            raise AppException(
                400,
                "GROUP_TOO_LARGE",
                f"Encrypted chats are limited to {epoch_service.MAX_E2E_GROUP_MEMBERS} members "
                f"because key distribution cost grows with the square of the membership.",
            )

    stmt = (
        postgresql.insert(ChatParticipant)
        .values(
            [
                {"chat_id": chat_id, "user_id": user_id, "role": ParticipantRole.MEMBER}
                for user_id in user_ids
            ]
        )
        .on_conflict_do_nothing(index_elements=["chat_id", "user_id"])
    )

    result = await db.execute(stmt)

    epoch = await epoch_service.rotate_if_encrypted(
        db,
        chat_id,
        EpochReason.MEMBER_ADDED,
        joining_user_ids=user_ids,
        mongo_db=mongo_db,
    )

    await db.commit()
    return result.rowcount, epoch


async def leave_chat(
    db: AsyncSession,
    chat_id: uuid.UUID,
    user_id: uuid.UUID,
    mongo_db=None,
) -> "ChatKeyEpoch | None":
    """Remove yourself from a chat. Same rotation requirement as being removed by an admin."""
    await db.execute(
        delete(ChatParticipant).where(
            ChatParticipant.chat_id == chat_id,
            ChatParticipant.user_id == user_id,
        )
    )

    epoch = await epoch_service.rotate_if_encrypted(
        db, chat_id, EpochReason.MEMBER_REMOVED, mongo_db=mongo_db
    )

    await db.commit()
    return epoch


async def transfer_ownership(
    db: AsyncSession,
    chat_id: uuid.UUID,
    current_owner_id: uuid.UUID,
    new_owner_id: uuid.UUID,
) -> ChatParticipant:
    """Hand OWNER to another member, demoting yourself to ADMIN.

    There was no way to do this: `change_role` refuses to grant OWNER, and `leave_chat` tells the
    owner to "transfer ownership before leaving, or delete the chat" — neither of which existed.
    An owner was therefore permanently stuck in every group they created.

    One statement per row inside one transaction, so the chat can never be observed with two
    owners or none.
    """
    target = (
        await db.execute(
            select(ChatParticipant).where(
                ChatParticipant.chat_id == chat_id,
                ChatParticipant.user_id == new_owner_id,
            )
        )
    ).scalar_one_or_none()

    if target is None:
        raise AppException(400, "USER_NOT_IN_CHAT", "That user is not in this chat.")

    await db.execute(
        update(ChatParticipant)
        .where(
            ChatParticipant.chat_id == chat_id,
            ChatParticipant.user_id == current_owner_id,
        )
        .values(role=ParticipantRole.ADMIN)
    )
    await db.execute(
        update(ChatParticipant)
        .where(
            ChatParticipant.chat_id == chat_id, ChatParticipant.user_id == new_owner_id
        )
        .values(role=ParticipantRole.OWNER)
    )

    await db.commit()
    await db.refresh(target)
    return target


async def delete_chat(
    db: AsyncSession,
    mongo_db,
    chat_id: uuid.UUID,
) -> list[uuid.UUID]:
    """Delete a chat, its participants and every message in it. Returns who to notify.

    Also missing entirely, which is why groups accumulated forever. Participants are read before
    the delete, because after it there is nobody left to send the notification to.

    Messages live in Mongo and the chat row lives in Postgres, so this cannot be one transaction.
    Mongo goes first: an orphaned Postgres row is a chat that still lists and can be retried,
    whereas orphaned Mongo documents are invisible and unreachable forever.
    """
    participant_ids = list(await get_chat_participants_ids(db, chat_id))

    await mongo_db["messages"].delete_many({"chat_id": chat_id})

    await db.execute(delete(Chat).where(Chat.id == chat_id))
    await db.commit()

    return participant_ids


async def change_role(
    db: AsyncSession, chat_id: uuid.UUID, user_id: uuid.UUID, role: ParticipantRole
) -> ChatParticipant | None:
    stmt = (
        update(ChatParticipant)
        .where(
            ChatParticipant.chat_id == chat_id,
            ChatParticipant.user_id == user_id,
        )
        .values(role=role)
        .returning(ChatParticipant)
    )

    res = await db.execute(stmt)
    await db.commit()

    return res.scalar_one_or_none()
