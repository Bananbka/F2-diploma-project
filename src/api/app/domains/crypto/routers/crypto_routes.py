import uuid

from fastapi import APIRouter, Depends, Path, Query
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.responses import SuccessResponse
from app.domains.chats.models import ChatType, ParticipantRole
from app.domains.chats.services import chat_services
from app.domains.crypto.reference.grants import compute_member_set_hash
from app.domains.crypto.schemas.crypto_schemas import (
    IdentityPublishRequest,
    OwnIdentityResponse,
    PrekeyRotateRequest,
    PublicKeyResponse,
    SafetyNumberResponse,
    UserKeysRequest,
)
from app.domains.crypto.schemas.epoch_schemas import (
    ChatKeysResponse,
    EpochResponse,
    RosterEntry,
    RosterResponse,
    SenderKeyPublishedResponse,
    SenderKeyUpload,
)
from app.domains.crypto.services import epoch_service, identity_service
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis
from app.infrastructure.services import redis_service

router = APIRouter(prefix="/crypto", tags=["Crypto"])


@router.post("/identity", response_model=SuccessResponse[PublicKeyResponse])
async def publish_identity(
        data: IdentityPublishRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis),
        mongo_db=Depends(get_mongo_db),
):
    """Publish or rotate this device's identity keys.

    Publishing enlarges the member set of every encrypted chat this user belongs to, so each of those
    chats is rotated in the same transaction. Skipping the rotation strands the new device: grants are
    wrapped per device, chains already published in the open epoch have none for it, and
    `uq_skd_epoch_sender_device` prevents senders from adding one later.
    """
    key = await identity_service.publish_identity(db, user.id, data)

    epochs = await epoch_service.rotate_chats_for_new_device(db, user.id, mongo_db=mongo_db)
    await db.commit()

    # Best-effort, like every other epoch announcement: anyone offline reconciles on reconnect.
    for chat_id, epoch in epochs:
        participant_ids = await chat_services.get_chat_participants_ids(db, chat_id)
        await redis_service.send_key_epoch_started(
            redis,
            chat_id=chat_id,
            epoch=epoch.epoch,
            member_set_hash=epoch.member_set_hash,
            reason=epoch.reason.value if hasattr(epoch.reason, "value") else str(epoch.reason),
            recipient_ids=list(participant_ids),
        )

    return SuccessResponse(data=key, meta={"rotated_chats": len(epochs)})


@router.get("/identity/me", response_model=SuccessResponse[list[OwnIdentityResponse]])
async def get_my_identities(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Own key material including the wrapped private bundle, for unlocking after login."""
    keys = await identity_service.get_own_identities(db, user.id)
    return SuccessResponse(data=keys)


@router.put("/identity/prekey", response_model=SuccessResponse[PublicKeyResponse])
async def rotate_prekey(
        data: PrekeyRotateRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Rotate the medium-term signed prekey. Does not invalidate existing key grants."""
    key = await identity_service.rotate_prekey(db, user.id, data)
    return SuccessResponse(data=key)


@router.post("/keys/batch", response_model=SuccessResponse[list[PublicKeyResponse]])
async def get_keys_batch(
        data: UserKeysRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Batch-fetch public keys. Called before wrapping group keys for a chat's members."""
    keys = await identity_service.get_active_keys_for_users(db, data.user_ids)
    return SuccessResponse(data=keys, meta={"count": len(keys)})


@router.post("/chats/{chat_id}/enable", response_model=SuccessResponse[EpochResponse])
async def enable_chat_encryption(
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Enable end-to-end encryption and open the chat's first epoch.

    Group chats are owner-only: turning encryption on commits every member to a key epoch, which is
    a decision for whoever administers the group.

    Private chats are the exception, and must be, because `get_or_create_private_chat` gives both
    participants MEMBER and no OWNER at all. An owner-only rule therefore made private chats
    permanently unencryptable — the exact opposite of the design, where PRIVATE is the one chat type
    that is genuinely end-to-end. There is no hierarchy in a two-party chat, so either side may
    enable it, and either side doing so is the outcome both want.
    """
    participant = await messages_service.is_user_in_chat(db, user.id, chat_id)
    if participant is None:
        raise AppException(403, "ACCESS_DENIED", "You are not a participant of this chat.")

    chat = await chat_services.get_chat_by_id(db, chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Chat doesn't exist.")

    if chat.chat_type is not ChatType.PRIVATE and participant.role is not ParticipantRole.OWNER:
        raise AppException(403, "ACCESS_DENIED", "Only the owner can enable encryption.")

    epoch = await epoch_service.enable_encryption(db, chat, user.id)
    return SuccessResponse(data=epoch)


@router.get("/chats/{chat_id}/roster", response_model=SuccessResponse[RosterResponse])
async def get_chat_roster(
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Member devices and their public keys, plus the current epoch's member set hash.

    The client MUST compare `member_set_hash` against a hash it computes from `members` before
    wrapping any key. A server that inserts a ghost device is otherwise undetectable.
    """
    await messages_service.get_chat_or_403(db, chat_id, user.id)

    settings = await epoch_service.get_settings_or_404(db, chat_id)
    roster = await epoch_service.get_roster(db, chat_id)

    return SuccessResponse(data=RosterResponse(
        chat_id=chat_id,
        current_epoch=settings.current_epoch,
        member_set_hash=compute_member_set_hash([r["device_id"] for r in roster]),
        members=[RosterEntry(**r) for r in roster],
    ))


@router.get("/chats/{chat_id}/keys", response_model=SuccessResponse[ChatKeysResponse])
async def get_chat_keys(
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        since_epoch: int = Query(0, ge=0, description="Only return epochs after this one"),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Epochs and the key grants addressed to the caller's devices."""
    await messages_service.get_chat_or_403(db, chat_id, user.id)

    keys = await epoch_service.get_chat_keys(db, chat_id, user.id, since_epoch)
    return SuccessResponse(data=keys)


@router.post(
    "/chats/{chat_id}/epochs/{epoch}/sender-keys",
    response_model=SuccessResponse[SenderKeyPublishedResponse],
)
async def publish_sender_key(
        data: SenderKeyUpload,
        chat_id: uuid.UUID = Path(..., description="Chat ID"),
        epoch: int = Path(..., ge=1, description="Epoch to publish into"),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Publish a chain for this epoch, with one wrapped copy per member device.

    Done lazily on first send rather than at rotation time, so a member who never sends never pays
    the wrapping cost and rotation never waits for anyone to be online.
    """
    await messages_service.get_chat_or_403(db, chat_id, user.id)

    distribution = await epoch_service.publish_sender_key(db, chat_id, user.id, epoch, data)

    return SuccessResponse(data=SenderKeyPublishedResponse(
        distribution_id=distribution.id,
        epoch=epoch,
        sender_key_id=distribution.sender_key_id,
        grant_count=len(data.grants),
    ))


@router.get("/safety-number/{peer_user_id}", response_model=SuccessResponse[SafetyNumberResponse])
async def get_safety_number(
        peer_user_id: uuid.UUID = Path(..., description="The user to verify against"),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Fingerprint for out-of-band verification.

    Users compare this through a channel the server does not control (in person, by voice). It is
    the only defence against the server substituting a public key, and it must visibly change if
    a peer's key ever changes.
    """
    number = await identity_service.compute_safety_number(db, user.id, peer_user_id)

    return SuccessResponse(data=SafetyNumberResponse(
        user_id=user.id,
        peer_user_id=peer_user_id,
        safety_number=number,
    ))
