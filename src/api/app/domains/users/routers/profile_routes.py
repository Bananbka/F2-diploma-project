from loguru import logger
from fastapi import APIRouter, Depends, Path, Request, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.audit import AuditEvent
from app.core.config import settings
from app.core.exceptions import AppException
from app.core.rate_limit import client_identifier, enforce_rate_limit, reset_rate_limit
from app.core.responses import SuccessResponse
from app.core.security import delete_token_cookies, revocation_cutoff, verify_password
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.domains.users.schemas.profile_schemas import ProfileRequestSchema
from app.domains.users.schemas.user_schemas import AccountDeleteRequest, UserResponse
from app.domains.users.routers.auth_routes import (
    CHANGE_PASSWORD_PER_ACCOUNT,
    CHANGE_PASSWORD_WINDOW,
    REAUTH_SCOPE,
)
from app.domains.users.services import account_deletion_service
from app.domains.users.services.profile_service import is_username_taken
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.redis import get_redis
from app.infrastructure.services import redis_service
from app.infrastructure.minio import minio_manager
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/profile", tags=["Profile"])


@router.get("/me", response_model=SuccessResponse[UserResponse])
async def get_me(current_user: User = Depends(get_current_user)):
    return SuccessResponse(data=current_user)


@router.patch("/me", response_model=SuccessResponse[UserResponse])
async def change_me(
    data_in: ProfileRequestSchema,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    update_data = data_in.model_dump(exclude_unset=True)
    if not update_data:
        return SuccessResponse(data=user)

    if "username" in update_data:
        new_username = update_data["username"]
        # A null username would clear a NOT NULL column. Omitting the key is how you leave it
        # alone; sending null is a mistake, not an instruction.
        if new_username is None:
            raise AppException(
                400,
                "INVALID_USERNAME",
                "Username cannot be cleared; omit the field instead.",
            )

        if await is_username_taken(db, new_username, user.id):
            raise AppException(400, "USERNAME_TAKEN", "Username is already taken.")

    if update_data.get("full_name", "") is None:
        raise AppException(
            400,
            "INVALID_NAME",
            "Display name cannot be cleared; omit the field instead.",
        )

    old_avatar_url = user.avatar_url if "avatar_url" in update_data else None

    for key, value in update_data.items():
        setattr(user, key, value)

    await db.commit()
    await db.refresh(user)

    # Only reap the old object once the replacement has actually landed — deleting it first and
    # having the commit fail would leave the profile pointing at an already-deleted avatar.
    #
    # Re-check against the database immediately before deleting: a concurrent PATCH could have
    # swapped the avatar back to old_avatar_url between our commit above and this point (e.g. A
    # changes X->Y while B concurrently changes Y->X). Comparing against the in-memory `user`
    # object here would still be comparing against the stale value captured before commit, so we
    # issue a fresh column-level SELECT rather than trusting the ORM identity map.
    if old_avatar_url is not None and old_avatar_url != user.avatar_url:
        current_avatar_url = await db.scalar(select(User.avatar_url).where(User.id == user.id))
        if current_avatar_url != old_avatar_url:
            await minio_manager.delete_file(old_avatar_url, settings.MINIO_AVATAR_BUCKET)

    return SuccessResponse(data=user)


# Same budget and the same counter as change-password: both re-check the password of an
# already-authenticated session, so a stolen cookie must not become an unlimited password-guessing
# oracle, and alternating between the two endpoints must not double the guesses.
DELETE_ACCOUNT_WINDOW = CHANGE_PASSWORD_WINDOW
DELETE_ACCOUNT_PER_ACCOUNT = CHANGE_PASSWORD_PER_ACCOUNT


@router.delete("", response_model=SuccessResponse[dict])
@router.delete("/", response_model=SuccessResponse[dict], include_in_schema=False)
async def delete_me(
    data: AccountDeleteRequest,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    """Delete the calling account. Irreversible.

    The account becomes a tombstone rather than disappearing: personal data is erased and the
    account can never sign in again, but its public keys, key distributions and messages stay so
    everyone else can still open and verify what it wrote. See
    `account_deletion_service` for exactly what is erased, kept and re-keyed.

    Once Postgres has committed, the deletion has happened: every later step is independent and
    best-effort, and the response is a success whatever they do.
    """
    await enforce_rate_limit(
        redis,
        scope=REAUTH_SCOPE,
        identifier=str(user.id),
        limit=DELETE_ACCOUNT_PER_ACCOUNT,
        window_seconds=DELETE_ACCOUNT_WINDOW,
        message="Too many failed attempts. Please wait and try again.",
    )

    if not verify_password(data.password, user.hashed_password):
        await audit.record(
            mongo_db,
            AuditEvent.PASSWORD_REAUTH_FAILED,
            user_id=user.id,
            client_ip=client_identifier(request),
            details={"action": "delete_account"},
        )
        raise AppException(401, "INVALID_PASSWORD", "Invalid password.")

    await reset_rate_limit(
        redis,
        scope=REAUTH_SCOPE,
        identifier=str(user.id),
        window_seconds=DELETE_ACCOUNT_WINDOW,
    )

    user_id = user.id
    outcome = await account_deletion_service.delete_account(db, user_id, mongo_db)

    # Cookies are cleared no matter what follows.
    delete_token_cookies(response)

    safely = account_deletion_service.safely

    # No client address and no name: the record must not carry what the deletion just erased.
    await safely(
        "audit",
        audit.record(
            mongo_db,
            AuditEvent.ACCOUNT_DELETED,
            user_id=user_id,
            details={
                "chats_left": sum(e.kind == "left" for e in outcome.effects),
                "chats_deleted": len(outcome.deleted_chat_ids),
                "private_chats_frozen": sum(e.kind == "peer_deleted" for e in outcome.effects),
                "ownership_transfers": sum(e.new_owner_id is not None for e in outcome.effects),
            },
        ),
    )
    for effect in outcome.effects:
        if effect.new_owner_id is not None:
            await safely(
                "audit ownership",
                audit.record(
                    mongo_db,
                    AuditEvent.OWNERSHIP_TRANSFERRED,
                    user_id=user_id,
                    chat_id=effect.chat_id,
                    details={
                        "new_owner_id": str(effect.new_owner_id),
                        "reason": "account_deleted",
                    },
                ),
            )

    await safely("force_logout", redis.setex(f"force_logout:{user_id}", 604800, revocation_cutoff()))
    await safely("session_revoked", redis_service.publish_session_revoked(redis, user_id, "all"))
    await safely("notify", _notify_chats(redis, outcome))
    await safely(
        "purge",
        account_deletion_service.purge_outside_postgres(
            mongo_db, minio_manager, settings, outcome
        ),
    )

    return SuccessResponse(data={"message": "Account deleted."})


async def _notify_chats(redis: Redis, outcome) -> None:
    """Tell the other members what changed. Delivery is best-effort, like every other fan-out."""
    for effect in outcome.effects:
        try:
            if effect.kind == "deleted":
                await redis_service.send_chat_deleted(
                    redis, effect.chat_id, effect.recipient_ids
                )
                continue

            if effect.kind == "left":
                await redis_service.send_participants_removed(
                    redis,
                    chat_id=effect.chat_id,
                    removed_ids=[outcome.user_id],
                    recipient_ids=effect.recipient_ids,
                )
                if effect.new_owner_id is not None:
                    await redis_service.send_chat_updated(
                        redis,
                        chat_id=effect.chat_id,
                        recipient_ids=effect.recipient_ids,
                        payload={"owner_id": str(effect.new_owner_id)},
                    )
            else:
                await redis_service.send_chat_updated(
                    redis,
                    chat_id=effect.chat_id,
                    recipient_ids=effect.recipient_ids,
                    payload={"peer_deleted": True, "user_id": str(outcome.user_id)},
                )

            if effect.epoch is not None:
                await redis_service.send_key_epoch_started(
                    redis,
                    chat_id=effect.chat_id,
                    epoch=effect.epoch.epoch,
                    member_set_hash=effect.epoch.member_set_hash,
                    reason=effect.epoch.reason.value,
                    recipient_ids=effect.recipient_ids,
                )
        except Exception as exc:
            logger.error(f"account deletion notice failed for chat {effect.chat_id}: {exc}")


@router.get("/is-username-available/{username}", response_model=SuccessResponse[bool])
async def is_username_available(
    current_user: User = Depends(get_current_user),
    username: str = Path(..., description="Username"),
    db: AsyncSession = Depends(get_db),
):
    res = await is_username_taken(db, username, current_user.id)
    return SuccessResponse(data=not res)
