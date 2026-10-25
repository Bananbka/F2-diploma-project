"""Account deletion as a tombstone.

The `users` row is **not** deleted. Every foreign key that points at it from the crypto directory
is `ON DELETE CASCADE`, so removing the row would remove the identity keys, sender key
distributions and grants with it, and the other members of every chat the account took part in
could then neither decrypt nor verify the history it wrote. Messages themselves live in MongoDB and
are never touched here, except those of chats that are deleted outright.

What happens instead, all in **one PostgreSQL transaction**:

  * every chat the account is in is row-locked (ascending id order) before anything is read, so a
    concurrent transfer, add, remove or another deletion cannot act on a stale membership;
  * personal data is replaced (name, username, email, phone, bio, avatar) with neutral values, the
    password is replaced by an unguessable one, `is_active` goes false and `deleted_at` is set;
  * sealed private key bundles and the legacy RSA private key are blanked, devices are revoked and
    their labels and last-seen times erased, and grants addressed to those devices are removed;
  * the account leaves every group and channel, and each encrypted chat opens a new key epoch in the
    same transaction (the departed account keeps every key it held, so the chat must re-key);
  * a group or channel owner hands ownership to the oldest admin, else the oldest member; a chat
    nobody else is in is deleted (its messages and their attachments are removed from Mongo and the
    object store *before* the commit, the same order `chat_services.delete_chat` uses);
  * private 1:1 chats keep the tombstone as a participant so the peer still sees who the history is
    with, but become read-only (see `messages_service.ensure_peer_not_deleted`); its read marker and
    mute state are cleared; a private chat whose peer is also deleted is deleted;
  * contacts (both directions), folders, sticker packs, pack subscriptions and invite links created
    by the account are removed.

Public keys, signatures and distributions stay: they are public, and they are exactly what lets
everyone else keep opening and verifying old messages.

Everything else (object store, Mongo reactions/pins, audit scrub, Redis sessions, WebSocket notices)
happens *after* the commit and is best-effort with logging, each step on its own, because it cannot
join the transaction and must never turn a committed deletion into an error response.
"""

import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from loguru import logger
from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.security import get_password_hash
from app.domains.chats.models import (
    Chat,
    ChatFolder,
    ChatInviteLink,
    ChatParticipant,
    ChatType,
    Contact,
    ParticipantRole,
)
from app.domains.chats.services import chat_services
from app.domains.crypto.models import (
    ChatKeyEpoch,
    EpochReason,
    SenderKeyGrant,
    UserDevice,
    UserIdentityKey,
)
from app.domains.crypto.services import epoch_service, identity_service
from app.domains.stickers.models import Sticker, StickerPack, StickerPackSubscription
from app.domains.users.models import User
from app.domains.users.schemas.user_schemas import DELETED_USER_FULL_NAME


@dataclass
class ChatEffect:
    """What deletion did to one chat, and who has to be told."""

    chat_id: uuid.UUID
    kind: str  # "left" | "peer_deleted" | "deleted"
    recipient_ids: list[uuid.UUID]
    epoch: ChatKeyEpoch | None = None
    new_owner_id: uuid.UUID | None = None


@dataclass
class DeletionOutcome:
    user_id: uuid.UUID
    old_username: str = ""
    chat_ids: list[uuid.UUID] = field(default_factory=list)
    effects: list[ChatEffect] = field(default_factory=list)
    avatar_url: str | None = None
    sticker_urls: list[str] = field(default_factory=list)

    @property
    def deleted_chat_ids(self) -> list[uuid.UUID]:
        return [e.chat_id for e in self.effects if e.kind == "deleted"]


async def safely(label: str, awaitable) -> None:
    """Run one post-commit step; log and swallow any failure so the others still run."""
    try:
        await awaitable
    except Exception as exc:
        logger.error(f"account deletion step failed ({label}): {exc!r}")


def _tombstone_identifiers(token: str) -> dict[str, str]:
    """Unique placeholders for the UNIQUE columns.

    The username contains a hyphen, which the registration pattern forbids, and the whole `deleted`
    prefix is reserved by the validators, so no one can register a name that collides with a
    tombstone (which would otherwise make the deletion fail on the unique index). `.invalid` is a
    reserved TLD and a real phone number starts with `+`. The former username and email become free.
    """
    return {
        "username": f"deleted-{token}",
        "email": f"deleted-{token}@deleted.invalid",
        "phone_number": f"x{token[:19]}",
    }


async def delete_account(
    db: AsyncSession, user_id: uuid.UUID, mongo_db=None
) -> DeletionOutcome:
    """Anonymise the account and detach it from everything, in one transaction. Commits.

    A unique-index collision on the placeholders (only possible if someone planted a colliding row
    by hand) is retried once with a random suffix.
    """
    for attempt in (0, 1):
        token = user_id.hex if attempt == 0 else uuid.uuid4().hex
        try:
            return await _delete_account_once(db, user_id, mongo_db, token)
        except IntegrityError:
            await db.rollback()
            if attempt == 1:
                raise
            logger.warning(f"tombstone identifiers collided for {user_id}; retrying")

    raise AssertionError("unreachable")


async def _lock_memberships(db: AsyncSession, user_id: uuid.UUID) -> list:
    """Lock every chat the account is in, then read the memberships under those locks.

    Repeated until stable: a join that landed between the unlocked read and the locks would
    otherwise be missed.
    """
    locked: set[uuid.UUID] = set()

    while True:
        chat_ids = list(
            (
                await db.execute(
                    select(ChatParticipant.chat_id)
                    .where(ChatParticipant.user_id == user_id)
                    .order_by(ChatParticipant.chat_id)
                )
            ).scalars()
        )
        missing = [c for c in chat_ids if c not in locked]
        if not missing:
            break

        await db.execute(
            select(Chat.id).where(Chat.id.in_(chat_ids)).order_by(Chat.id).with_for_update()
        )
        locked.update(chat_ids)

    return (
        await db.execute(
            select(ChatParticipant.chat_id, ChatParticipant.role, Chat.chat_type)
            .join(Chat, Chat.id == ChatParticipant.chat_id)
            .where(ChatParticipant.user_id == user_id)
            .order_by(ChatParticipant.chat_id)
        )
    ).all()


async def _delete_account_once(
    db: AsyncSession, user_id: uuid.UUID, mongo_db, token: str
) -> DeletionOutcome:
    # Chat locks come before the user row lock everywhere (add/remove/join take a chat lock and then
    # reference the user), so the two cannot deadlock against each other.
    memberships = await _lock_memberships(db, user_id)

    user = (
        await db.execute(
            select(User)
            .where(User.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()

    # Two concurrent deletions serialise on the locks above; the loser finds a tombstone.
    if user.deleted_at is not None:
        raise AppException(409, "ACCOUNT_ALREADY_DELETED", "This account is already deleted.")

    outcome = DeletionOutcome(
        user_id=user_id,
        old_username=user.username,
        avatar_url=user.avatar_url,
        chat_ids=[m.chat_id for m in memberships],
    )

    # Devices first: the roster that each new epoch commits to is built from active devices, and
    # it must already exclude this account.
    await identity_service.deactivate_user_devices(db, user_id)
    await db.execute(
        update(UserIdentityKey)
        .where(UserIdentityKey.user_id == user_id)
        .values(encrypted_private_bundle="", kdf_params={})
    )
    await db.execute(
        update(UserDevice)
        .where(UserDevice.user_id == user_id)
        .values(display_name="", last_seen_at=None)
    )
    # Grants addressed to this account's devices can never be opened again. Grants others hold, and
    # every distribution, stay: they are what lets old messages be opened and verified.
    await db.execute(delete(SenderKeyGrant).where(SenderKeyGrant.recipient_user_id == user_id))

    to_rotate: list[ChatEffect] = []

    for chat_id, role, chat_type in memberships:
        others = (
            await db.execute(
                select(
                    ChatParticipant.user_id,
                    ChatParticipant.role,
                    User.deleted_at,
                )
                .join(User, User.id == ChatParticipant.user_id)
                .where(ChatParticipant.chat_id == chat_id, ChatParticipant.user_id != user_id)
                .order_by(ChatParticipant.joined_at, ChatParticipant.user_id)
            )
        ).all()
        live = [o for o in others if o.deleted_at is None]

        if not live:
            # Nobody left who owns any of this data.
            await db.execute(delete(Chat).where(Chat.id == chat_id))
            outcome.effects.append(
                ChatEffect(chat_id, "deleted", [o.user_id for o in others])
            )
            continue

        live_ids = [o.user_id for o in live]

        if chat_type is ChatType.PRIVATE:
            effect = ChatEffect(chat_id, "peer_deleted", live_ids)
        else:
            effect = ChatEffect(chat_id, "left", live_ids)

            if role is ParticipantRole.OWNER:
                successor = next(
                    (o for o in live if o.role is ParticipantRole.ADMIN), live[0]
                )
                await db.execute(
                    update(ChatParticipant)
                    .where(
                        ChatParticipant.chat_id == chat_id,
                        ChatParticipant.user_id == successor.user_id,
                    )
                    .values(role=ParticipantRole.OWNER)
                )
                effect.new_owner_id = successor.user_id

            await db.execute(
                delete(ChatParticipant).where(
                    ChatParticipant.chat_id == chat_id,
                    ChatParticipant.user_id == user_id,
                )
            )

        outcome.effects.append(effect)
        to_rotate.append(effect)

    # Safety net: whatever happened above, the account must not remain in any group or channel.
    await db.execute(
        delete(ChatParticipant).where(
            ChatParticipant.user_id == user_id,
            ChatParticipant.chat_id.in_(
                select(Chat.id).where(Chat.chat_type != ChatType.PRIVATE)
            ),
        )
    )
    # What is left are rows in frozen private chats: drop the personal state on them.
    await db.execute(
        update(ChatParticipant)
        .where(ChatParticipant.user_id == user_id)
        .values(last_read_message_id=None, muted_until=None)
    )

    # Rotation after every membership change, so each roster is final when its epoch commits to it.
    for effect in to_rotate:
        effect.epoch = await epoch_service.rotate_if_encrypted(
            db, effect.chat_id, EpochReason.MEMBER_REMOVED
        )

    await db.execute(
        delete(Contact).where(or_(Contact.owner_id == user_id, Contact.contact_id == user_id))
    )
    await db.execute(delete(ChatFolder).where(ChatFolder.user_id == user_id))
    await db.execute(delete(ChatInviteLink).where(ChatInviteLink.created_by == user_id))
    await db.execute(
        delete(StickerPackSubscription).where(StickerPackSubscription.user_id == user_id)
    )

    outcome.sticker_urls = list(
        (
            await db.execute(
                select(Sticker.image_url)
                .join(StickerPack, StickerPack.id == Sticker.pack_id)
                .where(StickerPack.owner_id == user_id)
            )
        ).scalars()
    )
    await db.execute(delete(StickerPack).where(StickerPack.owner_id == user_id))

    placeholders = _tombstone_identifiers(token)
    user.full_name = DELETED_USER_FULL_NAME
    user.username = placeholders["username"]
    user.email = placeholders["email"]
    user.phone_number = placeholders["phone_number"]
    user.bio = None
    user.avatar_url = None
    # A valid hash of a secret nobody ever sees, rather than a sentinel string: the login path
    # runs bcrypt against whatever is stored, and a malformed hash would raise instead of failing.
    user.hashed_password = get_password_hash(secrets.token_urlsafe(32))
    # The legacy RSA *private* key is wrapped under the old password and useless to anyone else.
    # `public_key` stays: it is public, and old legacy-format history was sealed to it.
    user.encrypted_private_key = ""
    user.is_active = False
    user.is_verified = False
    user.deleted_at = datetime.now(timezone.utc)

    # Flushed before the irreversible Mongo step, so a unique-index collision surfaces (and is
    # retried) while nothing outside Postgres has been touched yet.
    await db.flush()

    # Messages of deleted chats go before the commit, like `chat_services.delete_chat`: an orphaned
    # Postgres row is recoverable, orphaned unreachable Mongo documents are not.
    if mongo_db is not None and outcome.deleted_chat_ids:
        await chat_services.purge_chat_messages(mongo_db, outcome.deleted_chat_ids)

    await db.commit()
    return outcome


async def purge_outside_postgres(mongo_db, minio, settings, outcome: DeletionOutcome) -> None:
    """Best-effort cleanup that cannot join the Postgres transaction. Never raises."""
    user_id = outcome.user_id

    if outcome.avatar_url:
        await safely(
            "avatar", minio.delete_file(outcome.avatar_url, settings.MINIO_AVATAR_BUCKET)
        )

    # Sticker objects of the packs this account owned go with the packs. A message that already
    # used one of those stickers will no longer render its image; that is the same behaviour as the
    # owner deleting the pack by hand.
    for url in outcome.sticker_urls:
        await safely("sticker", minio.delete_file(url, settings.MINIO_STICKER_BUCKET))

    if mongo_db is None:
        return

    messages = mongo_db["messages"]
    scope = {"chat_id": {"$in": outcome.chat_ids}}

    # Reactions are the account's own activity, not content other members own. The messages they
    # sit on are left exactly as they were.
    await safely(
        "reactions",
        messages.update_many(
            {**scope, "reactions.user_id": user_id},
            {"$pull": {"reactions": {"user_id": user_id}}},
        ),
    )
    # A pin is chat state and stays; only the attribution to the deleted account is dropped.
    await safely(
        "pins",
        messages.update_many({**scope, "pinned_by": user_id}, {"$set": {"pinned_by": None}}),
    )

    # The audit log is retained for a year but must not keep where the account signed in from, nor
    # the name it used. The `account_deleted` record itself carries neither.
    audit_log = mongo_db["security_audit"]
    await safely(
        "audit client_ip",
        audit_log.update_many({"user_id": user_id}, {"$unset": {"client_ip": ""}}),
    )
    if outcome.old_username:
        await safely(
            "audit failed logins",
            audit_log.delete_many(
                {"event": "login_failed", "details.username": outcome.old_username}
            ),
        )
