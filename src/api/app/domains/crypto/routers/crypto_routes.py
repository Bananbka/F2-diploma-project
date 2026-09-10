import uuid

from fastapi import APIRouter, Depends, Path, Query
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.audit import AuditEvent
from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.core.responses import SuccessResponse
from app.domains.chats.models import ChatType, ParticipantRole
from app.domains.chats.services import chat_services
from app.domains.crypto.models import EpochReason
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

# Publishing an identity re-keys every encrypted chat the caller is in, so the cost of a request
# is borne by every other member. Honest clients publish once at registration and rarely after.
IDENTITY_PUBLISH_WINDOW = 3600
IDENTITY_PUBLISH_LIMIT = 5


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
    # That rotation is exactly why this needs a limit. One request re-keys every encrypted chat
    # the caller belongs to and obliges every other member to re-wrap a grant per device on their
    # next send — so an unlimited publish endpoint is a cheap amplification lever against the
    # whole group, not just against the caller.
    await enforce_rate_limit(
        redis,
        scope="publish-identity",
        identifier=str(user.id),
        limit=IDENTITY_PUBLISH_LIMIT,
        window_seconds=IDENTITY_PUBLISH_WINDOW,
        message="Identity keys were published very recently. Please wait before rotating again.",
    )

    key = await identity_service.publish_identity(db, user.id, data)

    epochs = await epoch_service.rotate_chats_for_new_device(
        db, user.id, mongo_db=mongo_db
    )
    await db.commit()

    # Best-effort, like every other epoch announcement: anyone offline reconciles on reconnect.
    for chat_id, epoch in epochs:
        participant_ids = await chat_services.get_chat_participants_ids(db, chat_id)
        await redis_service.send_key_epoch_started(
            redis,
            chat_id=chat_id,
            epoch=epoch.epoch,
            member_set_hash=epoch.member_set_hash,
            reason=epoch.reason.value
            if hasattr(epoch.reason, "value")
            else str(epoch.reason),
            recipient_ids=list(participant_ids),
        )

    # A key change is what a successful server-side substitution looks like from the outside, so
    # it has to leave a trace here as well as showing up in the peer's safety number.
    await audit.record(
        mongo_db,
        AuditEvent.IDENTITY_PUBLISHED,
        user_id=user.id,
        details={
            "device_id": str(data.device_id),
            "version": key.version,
            "rotated_chats": len(epochs),
        },
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


@router.put(
    "/identity/prekey",
    response_model=SuccessResponse[PublicKeyResponse],
    deprecated=True,
)
async def rotate_prekey(
    data: PrekeyRotateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Disabled: rotating a prekey currently makes a device permanently unreadable.

    Senders wrap grants to `signed_prekey_public ?? identity_public_key`, but the private half of
    a rotated prekey has nowhere to live — the bundle is sealed under an Argon2id key derived from
    the password, and the password is not kept after unlock. So the moment a device publishes a
    prekey, every grant addressed to it becomes unopenable and every message reports `no_key`.
    This shipped once, was reverted, and the columns were cleared in the database.

    The endpoint stays mounted and returns 410 rather than being deleted, because a client built
    against the old contract must get a clear refusal instead of a 404 it might read as a routing
    mistake — and because silently accepting the rotation is how the original outage happened.

    The signature machinery around it (`DS_PREKEY_BIND`, `verify_signed_prekey`, the interop
    vector, the spec section) is correct and deliberately kept. Re-enable this only once the
    private bundle carries `prekey_private` from registration onward.
    """
    raise AppException(
        410,
        "PREKEY_ROTATION_DISABLED",
        "Signed-prekey rotation is disabled: the private half cannot yet be stored, so rotating "
        "would make every key grant addressed to this device permanently unopenable.",
    )


@router.post("/identity/{device_id}/revoke", response_model=SuccessResponse[dict])
async def revoke_device(
    device_id: uuid.UUID = Path(..., description="Device to revoke"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db=Depends(get_mongo_db),
):
    """Revoke one of your own devices — a lost phone, a borrowed laptop.

    Previously the only way to disown a device was `POST /auth/reset-password`, which destroys the
    identity entirely and makes all history unreadable. That is a wildly disproportionate response
    to losing one of two devices, so in practice nobody would do it and the device stayed trusted.

    Revoking removes the device from every chat roster, then re-keys each of the caller's
    encrypted chats so the revoked device receives no grant for anything sent afterwards. It keeps
    everything it already held — that is unavoidable — which is precisely why the re-key has to be
    part of the same transaction.
    """
    await identity_service.revoke_device(db, user.id, device_id)

    epochs = await epoch_service.rotate_chats_for_member_change(
        db,
        user.id,
        EpochReason.MEMBER_REMOVED,
        mongo_db=mongo_db,
    )
    await db.commit()

    for chat_id, epoch in epochs:
        participant_ids = await chat_services.get_chat_participants_ids(db, chat_id)
        await redis_service.send_key_epoch_started(
            redis,
            chat_id=chat_id,
            epoch=epoch.epoch,
            member_set_hash=epoch.member_set_hash,
            reason=epoch.reason.value
            if hasattr(epoch.reason, "value")
            else str(epoch.reason),
            recipient_ids=list(participant_ids),
        )

    await audit.record(
        mongo_db,
        AuditEvent.DEVICE_REVOKED,
        user_id=user.id,
        details={"device_id": str(device_id), "rotated_chats": len(epochs)},
    )

    return SuccessResponse(
        data={"message": "Device revoked."},
        meta={"rotated_chats": len(epochs)},
    )


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
    redis: Redis = Depends(get_redis),
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
        raise AppException(
            403, "ACCESS_DENIED", "You are not a participant of this chat."
        )

    chat = await chat_services.get_chat_by_id(db, chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Chat doesn't exist.")

    if (
        chat.chat_type is not ChatType.PRIVATE
        and participant.role is not ParticipantRole.OWNER
    ):
        raise AppException(
            403, "ACCESS_DENIED", "Only the owner can enable encryption."
        )

    epoch = await epoch_service.enable_encryption(db, chat, user.id)

    # Announce it, like every other rotation path does. Without this the other members learn the
    # chat became encrypted only when they happen to refetch — until then their clients keep
    # sending plaintext into a chat that now refuses it, which surfaces as a failed send rather
    # than as "this conversation is now encrypted".
    participant_ids = await chat_services.get_chat_participants_ids(db, chat_id)
    await redis_service.send_key_epoch_started(
        redis,
        chat_id=chat_id,
        epoch=epoch.epoch,
        member_set_hash=epoch.member_set_hash,
        reason=epoch.reason.value
        if hasattr(epoch.reason, "value")
        else str(epoch.reason),
        recipient_ids=list(participant_ids),
    )

    return SuccessResponse(data=epoch)


@router.get("/chats/{chat_id}/roster", response_model=SuccessResponse[RosterResponse])
async def get_chat_roster(
    chat_id: uuid.UUID = Path(..., description="Chat ID"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Member devices and their public keys, plus the current epoch's stored member set hash.

    Two client-side checks depend on what this returns, and both used to be defeatable:

    1. `member_set_hash` is read from the epoch row, **not** recomputed from the roster below.
       Recomputing it made the comparison tautological — the client hashed the same list the
       server had just hashed, so it matched for any list at all, ghost devices included.
    2. Each entry carries its binding signatures, so the client can verify that the X25519 key it
       is about to wrap for is vouched for by the Ed25519 key a peer pins out of band. Without
       them the roster is only an assertion by the server.
    """
    await messages_service.get_chat_or_403(db, chat_id, user.id)

    settings = await epoch_service.get_settings_or_404(db, chat_id)
    roster = await epoch_service.get_roster(db, chat_id)

    epoch = await epoch_service.get_epoch(db, chat_id, settings.current_epoch)
    if epoch is None:
        raise AppException(
            409,
            "EPOCH_MISSING",
            "This chat has no open epoch; it must be re-keyed before keys can be distributed.",
        )

    return SuccessResponse(
        data=RosterResponse(
            chat_id=chat_id,
            current_epoch=settings.current_epoch,
            member_set_hash=epoch.member_set_hash,
            members=[RosterEntry(**r) for r in roster],
        )
    )


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

    distribution = await epoch_service.publish_sender_key(
        db, chat_id, user.id, epoch, data
    )

    return SuccessResponse(
        data=SenderKeyPublishedResponse(
            distribution_id=distribution.id,
            epoch=epoch,
            sender_key_id=distribution.sender_key_id,
            grant_count=len(data.grants),
        )
    )


@router.get(
    "/safety-number/{peer_user_id}",
    response_model=SuccessResponse[SafetyNumberResponse],
)
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

    return SuccessResponse(
        data=SafetyNumberResponse(
            user_id=user.id,
            peer_user_id=peer_user_id,
            safety_number=number,
        )
    )
