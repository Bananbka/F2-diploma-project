"""Epoch allocation and sender key distribution.

The central design point: **an epoch carries no key material**, so the server can allocate one on
its own. Rotation is therefore never blocked on a client being online, and there is no state in
which a group cannot send. Clients supply key material lazily and independently, each for their own
chain.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.domains.chats.models import Chat, ChatParticipant, ChatType
from app.domains.crypto.models import (
    ChatCryptoSettings,
    ChatKeyEpoch,
    CryptoMode,
    EpochReason,
    HistoryVisibility,
    SenderKeyDistribution,
    SenderKeyGrant,
    UserDevice,
    UserIdentityKey,
)
from app.domains.crypto.reference.grants import compute_member_set_hash, verify_distribution
from app.domains.crypto.reference.primitives import b64u_decode

# Sender keys cost S x (N-1) grants per epoch, all wrapped on clients. Beyond a few hundred members
# that stops converging under normal churn, so the cap is enforced rather than merely documented.
# Signal caps groups at 1000 and WhatsApp at 1024; 256 leaves headroom.
MAX_E2E_GROUP_MEMBERS = 256


async def get_settings(db: AsyncSession, chat_id: uuid.UUID) -> ChatCryptoSettings | None:
    stmt = select(ChatCryptoSettings).where(ChatCryptoSettings.chat_id == chat_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_settings_or_404(db: AsyncSession, chat_id: uuid.UUID) -> ChatCryptoSettings:
    settings = await get_settings(db, chat_id)
    if settings is None:
        raise AppException(404, "CRYPTO_NOT_ENABLED", "Encryption is not enabled for this chat.")
    return settings


async def get_roster(db: AsyncSession, chat_id: uuid.UUID) -> list[dict]:
    """Active devices of current members, with the public keys needed to wrap for each.

    One query rather than N: a client calls this immediately before wrapping and needs every
    member's key material at once.
    """
    stmt = (
        select(UserIdentityKey, UserDevice.id, ChatParticipant.user_id)
        .join(UserDevice, UserDevice.id == UserIdentityKey.device_id)
        .join(ChatParticipant, ChatParticipant.user_id == UserDevice.user_id)
        .where(
            ChatParticipant.chat_id == chat_id,
            UserIdentityKey.is_active.is_(True),
            UserDevice.is_active.is_(True),
        )
    )
    rows = (await db.execute(stmt)).all()

    return [
        {
            "user_id": row.user_id,
            "device_id": row[1],
            "identity_key_id": row.UserIdentityKey.id,
            "identity_public_key": row.UserIdentityKey.identity_public_key,
            "signing_public_key": row.UserIdentityKey.signing_public_key,
            "signed_prekey_public": row.UserIdentityKey.signed_prekey_public,
        }
        for row in rows
    ]


async def _newest_message_id(mongo_db, chat_id: uuid.UUID) -> str | None:
    doc = await mongo_db["messages"].find_one({"chat_id": chat_id}, sort=[("_id", -1)])
    return str(doc["_id"]) if doc else None


async def allocate_epoch(
        db: AsyncSession,
        chat_id: uuid.UUID,
        reason: EpochReason,
        created_by_user_id: uuid.UUID | None = None,
        joining_user_ids: list[uuid.UUID] | None = None,
        mongo_db=None,
) -> ChatKeyEpoch:
    """Close the open epoch and open the next one. Server-side only; no key material involved.

    Caller owns the commit so this lands atomically with whatever membership change triggered it.
    """
    settings = await get_settings_or_404(db, chat_id)

    # Serialise allocation per chat so two concurrent triggers cannot claim the same epoch number.
    # The uq_chat_epoch constraint is the backstop if they race despite this. Bound as a parameter
    # rather than interpolated into the statement.
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(str(chat_id)))))

    roster = await get_roster(db, chat_id)
    device_ids = [r["device_id"] for r in roster]

    await db.execute(
        update(ChatKeyEpoch)
        .where(ChatKeyEpoch.chat_id == chat_id, ChatKeyEpoch.closed_at.is_(None))
        .values(closed_at=datetime.now(timezone.utc))
    )

    next_epoch = settings.current_epoch + 1
    epoch = ChatKeyEpoch(
        chat_id=chat_id,
        epoch=next_epoch,
        reason=reason,
        created_by_user_id=created_by_user_id,
        member_count=len(device_ids),
        member_set_hash=compute_member_set_hash(device_ids),
    )
    db.add(epoch)

    settings.current_epoch = next_epoch
    settings.last_rotated_at = datetime.now(timezone.utc)

    if joining_user_ids and settings.history_visibility is HistoryVisibility.JOINED:
        floor = await _newest_message_id(mongo_db, chat_id) if mongo_db is not None else None
        await db.execute(
            update(ChatParticipant)
            .where(
                ChatParticipant.chat_id == chat_id,
                ChatParticipant.user_id.in_(joining_user_ids),
            )
            .values(joined_at_epoch=next_epoch, history_start_message_id=floor)
        )

    await db.flush()
    await db.refresh(epoch)
    return epoch


async def rotate_if_encrypted(
        db: AsyncSession,
        chat_id: uuid.UUID,
        reason: EpochReason,
        created_by_user_id: uuid.UUID | None = None,
        joining_user_ids: list[uuid.UUID] | None = None,
        mongo_db=None,
) -> ChatKeyEpoch | None:
    """Rotate a chat's epoch if it is encrypted, otherwise do nothing.

    Does not commit — the caller commits so the rotation lands atomically with the membership
    change that triggered it. A removal that committed without its rotation would leave the
    departed member able to read everything sent in the interim.
    """
    settings = await get_settings(db, chat_id)
    if settings is None or settings.crypto_mode is not CryptoMode.SENDER_KEYS_V1:
        return None

    # Adding a member does not require rotation when history is shared: existing members backfill
    # grants for earlier epochs instead, and the joiner is meant to see that history anyway.
    if (
        reason is EpochReason.MEMBER_ADDED
        and settings.history_visibility is HistoryVisibility.SHARED
    ):
        return None

    return await allocate_epoch(
        db, chat_id, reason,
        created_by_user_id=created_by_user_id,
        joining_user_ids=joining_user_ids,
        mongo_db=mongo_db,
    )


async def rotate_chats_for_new_device(
        db: AsyncSession,
        user_id: uuid.UUID,
        mongo_db=None,
) -> list[tuple[uuid.UUID, ChatKeyEpoch]]:
    """Rotate every encrypted chat this user belongs to, because they gained a device.

    A new device changes the member set of each of those chats, and grants are wrapped per device.
    Without a rotation the device is stranded: chains already published in the open epoch carry no
    grant for it, and `uq_skd_epoch_sender_device` allows only one distribution per device per epoch,
    so no sender can top the missing grants up afterwards. Every message in that epoch would report
    `no_key` on the new device forever, with nothing able to resolve it.

    Rotating opens a fresh epoch whose roster includes the device, and senders mint a chain for it on
    their next send. Does not commit — the caller commits so the rotation lands atomically with the
    identity that triggered it.
    """
    chat_ids = (await db.execute(
        select(ChatParticipant.chat_id)
        .join(ChatCryptoSettings, ChatCryptoSettings.chat_id == ChatParticipant.chat_id)
        .where(
            ChatParticipant.user_id == user_id,
            ChatCryptoSettings.crypto_mode == CryptoMode.SENDER_KEYS_V1,
        )
    )).scalars().all()

    rotated = []
    for chat_id in chat_ids:
        epoch = await allocate_epoch(
            db, chat_id, EpochReason.MEMBER_ADDED,
            created_by_user_id=user_id,
            mongo_db=mongo_db,
        )
        if epoch is not None:
            rotated.append((chat_id, epoch))

    return rotated


async def enable_encryption(
        db: AsyncSession,
        chat: Chat,
        user_id: uuid.UUID,
) -> ChatKeyEpoch:
    """Turn on end-to-end encryption for a chat and open its first epoch."""
    if await get_settings(db, chat.id) is not None:
        raise AppException(409, "ALREADY_ENABLED", "Encryption is already enabled for this chat.")

    if chat.chat_type is ChatType.CHANNEL:
        raise AppException(
            400, "CHANNEL_NOT_SUPPORTED",
            "Channels are broadcast and are authenticated by signature rather than encrypted.",
        )

    member_count = await db.scalar(
        select(func.count()).select_from(ChatParticipant).where(ChatParticipant.chat_id == chat.id)
    )
    if member_count > MAX_E2E_GROUP_MEMBERS:
        raise AppException(
            400, "GROUP_TOO_LARGE",
            f"Encrypted chats are limited to {MAX_E2E_GROUP_MEMBERS} members "
            f"because key distribution cost grows with the square of the membership.",
        )

    db.add(ChatCryptoSettings(chat_id=chat.id, crypto_mode=CryptoMode.SENDER_KEYS_V1))
    await db.flush()

    epoch = await allocate_epoch(db, chat.id, EpochReason.INITIAL, created_by_user_id=user_id)

    await db.commit()
    await db.refresh(epoch)
    return epoch


async def get_epoch(db: AsyncSession, chat_id: uuid.UUID, epoch: int) -> ChatKeyEpoch | None:
    stmt = select(ChatKeyEpoch).where(
        ChatKeyEpoch.chat_id == chat_id, ChatKeyEpoch.epoch == epoch
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_distribution(
        db: AsyncSession,
        chat_id: uuid.UUID,
        epoch_number: int,
        sender_key_id: uuid.UUID,
) -> SenderKeyDistribution | None:
    """Look up a published chain by its opaque handle, scoped to one epoch."""
    stmt = (
        select(SenderKeyDistribution)
        .join(ChatKeyEpoch, ChatKeyEpoch.id == SenderKeyDistribution.epoch_id)
        .where(
            SenderKeyDistribution.chat_id == chat_id,
            SenderKeyDistribution.sender_key_id == sender_key_id,
            ChatKeyEpoch.epoch == epoch_number,
        )
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def publish_sender_key(
        db: AsyncSession,
        chat_id: uuid.UUID,
        user_id: uuid.UUID,
        epoch_number: int,
        data,
) -> SenderKeyDistribution:
    """Store a sender's chain distribution plus its wrapped grants, in one transaction."""
    epoch = await get_epoch(db, chat_id, epoch_number)
    if epoch is None:
        raise AppException(404, "EPOCH_NOT_FOUND", "No such epoch for this chat.")

    if epoch.closed_at is not None:
        raise AppException(
            409, "EPOCH_CLOSED",
            "This epoch has been superseded; fetch the current one and publish there.",
        )

    device = await db.get(UserDevice, data.sender_device_id)
    if device is None or device.user_id != user_id or not device.is_active:
        raise AppException(400, "UNKNOWN_DEVICE", "Unknown or inactive sender device.")

    identity = (await db.execute(
        select(UserIdentityKey).where(
            UserIdentityKey.device_id == device.id, UserIdentityKey.is_active.is_(True)
        )
    )).scalar_one_or_none()
    if identity is None:
        raise AppException(400, "NO_IDENTITY_KEY", "This device has no active identity key.")

    # Verify the sender's long-term key vouches for this chain's signing key. Without this the
    # server would happily store a distribution the claimed sender never made.
    if not verify_distribution(
            identity_signing_public=b64u_decode(identity.signing_public_key),
            signature=b64u_decode(data.signature),
            chat_id=chat_id,
            epoch=epoch_number,
            sender_key_id=data.sender_key_id,
            chain_signing_public=b64u_decode(data.signing_public_key),
            chain_start_index=data.chain_start_index,
    ):
        raise AppException(
            400, "INVALID_DISTRIBUTION_SIGNATURE",
            "The distribution signature does not verify against your identity key.",
        )

    roster = await get_roster(db, chat_id)
    expected_devices = {r["device_id"] for r in roster}
    supplied_devices = {g.recipient_device_id for g in data.grants}

    # A partial upload is either a client bug or an attempt to silently exclude someone, so it is
    # rejected rather than accepted and quietly under-delivered.
    if supplied_devices != expected_devices:
        missing = expected_devices - supplied_devices
        extra = supplied_devices - expected_devices
        raise AppException(
            400, "GRANT_SET_MISMATCH",
            "Grants must cover exactly the epoch's member devices.",
            details={"missing": [str(d) for d in missing], "unexpected": [str(d) for d in extra]},
        )

    distribution = SenderKeyDistribution(
        epoch_id=epoch.id,
        chat_id=chat_id,
        sender_user_id=user_id,
        sender_device_id=device.id,
        sender_key_id=data.sender_key_id,
        algorithm=data.algorithm,
        signing_public_key=data.signing_public_key,
        chain_start_index=data.chain_start_index,
        signature=data.signature,
    )
    db.add(distribution)
    await db.flush()

    device_to_user = {r["device_id"]: r["user_id"] for r in roster}
    device_to_key = {r["device_id"]: r["identity_key_id"] for r in roster}

    await db.execute(
        pg_insert(SenderKeyGrant).values([
            {
                "distribution_id": distribution.id,
                "chat_id": chat_id,
                "recipient_user_id": device_to_user[g.recipient_device_id],
                "recipient_device_id": g.recipient_device_id,
                "recipient_identity_key_id": device_to_key[g.recipient_device_id],
                "granted_by_user_id": user_id,
                "wrap_algorithm": g.wrap_algorithm,
                "ephemeral_public_key": g.ephemeral_public_key,
                "wrapped_chain_key": g.wrapped_chain_key,
            }
            for g in data.grants
        ]).on_conflict_do_nothing(
            index_elements=["distribution_id", "recipient_device_id"]
        )
    )

    await db.commit()
    await db.refresh(distribution)
    return distribution


async def get_chat_keys(
        db: AsyncSession,
        chat_id: uuid.UUID,
        user_id: uuid.UUID,
        since_epoch: int = 0,
) -> dict:
    """Everything a client needs to decrypt: epochs, plus the grants addressed to its devices.

    A distribution with `grant: null` means that sender has not wrapped for this device yet — the
    client should request one rather than treat the message as undecryptable.
    """
    settings = await get_settings_or_404(db, chat_id)

    participant = (await db.execute(
        select(ChatParticipant).where(
            ChatParticipant.chat_id == chat_id, ChatParticipant.user_id == user_id
        )
    )).scalar_one_or_none()

    epochs = (await db.execute(
        select(ChatKeyEpoch)
        .where(ChatKeyEpoch.chat_id == chat_id, ChatKeyEpoch.epoch > since_epoch)
        .order_by(ChatKeyEpoch.epoch)
    )).scalars().all()

    my_device_ids = (await db.execute(
        select(UserDevice.id).where(
            UserDevice.user_id == user_id, UserDevice.is_active.is_(True)
        )
    )).scalars().all()

    rows = (await db.execute(
        select(SenderKeyDistribution, ChatKeyEpoch.epoch, SenderKeyGrant)
        .join(ChatKeyEpoch, ChatKeyEpoch.id == SenderKeyDistribution.epoch_id)
        .outerjoin(
            SenderKeyGrant,
            (SenderKeyGrant.distribution_id == SenderKeyDistribution.id)
            & (SenderKeyGrant.recipient_device_id.in_(my_device_ids)),
        )
        .where(
            SenderKeyDistribution.chat_id == chat_id,
            ChatKeyEpoch.epoch > since_epoch,
        )
        .order_by(ChatKeyEpoch.epoch)
    )).all()

    distributions = []
    delivered_ids = []
    for dist, epoch_number, grant in rows:
        entry = {
            "distribution_id": dist.id,
            "epoch": epoch_number,
            "sender_user_id": dist.sender_user_id,
            "sender_device_id": dist.sender_device_id,
            "sender_key_id": dist.sender_key_id,
            "algorithm": dist.algorithm,
            "signing_public_key": dist.signing_public_key,
            "chain_start_index": dist.chain_start_index,
            "signature": dist.signature,
            "grant": None,
        }

        if grant is not None:
            entry["grant"] = {
                "recipient_device_id": grant.recipient_device_id,
                "recipient_identity_key_id": grant.recipient_identity_key_id,
                "wrap_algorithm": grant.wrap_algorithm,
                "ephemeral_public_key": grant.ephemeral_public_key,
                "wrapped_chain_key": grant.wrapped_chain_key,
            }
            if grant.delivered_at is None:
                delivered_ids.append(grant.id)

        distributions.append(entry)

    if delivered_ids:
        await db.execute(
            update(SenderKeyGrant)
            .where(SenderKeyGrant.id.in_(delivered_ids))
            .values(delivered_at=datetime.now(timezone.utc))
        )
        await db.commit()

    return {
        "crypto_mode": settings.crypto_mode,
        "history_visibility": settings.history_visibility,
        "current_epoch": settings.current_epoch,
        "my_join_epoch": participant.joined_at_epoch if participant else None,
        "epochs": epochs,
        "distributions": distributions,
    }
