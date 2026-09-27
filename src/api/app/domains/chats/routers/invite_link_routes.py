import uuid

from fastapi import APIRouter, Depends, Path
from motor.motor_asyncio import AsyncIOMotorDatabase
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.audit import AuditEvent
from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.core.responses import SuccessResponse
from app.domains.chats.models import ChatType, ParticipantRole
from app.domains.chats.routers.chat_routes import _announce_epoch
from app.domains.chats.schemas.invite_link_schemas import (
    CreateInviteLinkRequest,
    InviteLinkJoinResponse,
    InviteLinkPreviewResponse,
    InviteLinkResponse,
)
from app.domains.chats.services import chat_services, invite_link_services
from app.domains.messages.services import messages_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis
from app.infrastructure.services import redis_service

# Chat-scoped: create/list, gated to admins/owners of that specific chat — same
# `chat_services.role_rank` pattern pinning uses.
chat_scoped_router = APIRouter(prefix="/chats", tags=["Invite Links"])

# Token-scoped: preview/join/revoke. Kept separate from `chat_scoped_router` because these are
# not addressed by chat id at all — the token is the whole address, deliberately (a client that
# only has a link should never need to know the chat id up front).
router = APIRouter(prefix="/invite-links", tags=["Invite Links"])

# Creation/revocation are rare admin actions; generous headroom mostly bounds a buggy client.
INVITE_MANAGE_WINDOW = 3600
INVITE_MANAGE_LIMIT = 30

# Preview and join are the closest thing this app has to a token-guessing surface. Both endpoints
# require authentication like everything else here (cookie-based JWT, no anonymous accounts — see
# CLAUDE.md), so per-user limiting is sufficient; there is no unauthenticated route that reaches
# either of them, unlike e.g. a password-reset link.
INVITE_GUESS_WINDOW = 60
INVITE_GUESS_LIMIT = 20

# Listing is a plain read triggered by opening the chat-info panel, not an admin action taken
# rarely like create/revoke, so it needs more headroom than INVITE_MANAGE_* while still bounding a
# buggy or malicious client — same window, double the budget.
INVITE_LIST_WINDOW = 3600
INVITE_LIST_LIMIT = 60


async def _require_manage_rank(
    db: AsyncSession, user_id: uuid.UUID, chat_id: uuid.UUID
):
    """Resolve the chat and the caller's participant row, and enforce ADMIN/OWNER + non-PRIVATE.

    Shared by create/list/revoke so the three gates (membership, chat type, rank) can never drift
    apart between them.
    """
    participant = await messages_service.is_user_in_chat(db, user_id, chat_id)
    if participant is None:
        raise AppException(
            403, "ACCESS_DENIED", "You dont have permission to access this chat."
        )

    chat = await chat_services.get_chat_by_id(db, chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Chat doesn't exist.")

    if chat.chat_type == ChatType.PRIVATE:
        raise AppException(
            400,
            "INVALID_CHAT_TYPE",
            "A private chat has exactly two fixed participants and cannot have invite links.",
        )

    if chat_services.role_rank(participant.role) < chat_services.role_rank(
        ParticipantRole.ADMIN
    ):
        raise AppException(
            403,
            "ACCESS_DENIED",
            "You dont have permission to manage invite links for this chat.",
        )

    return chat, participant


@chat_scoped_router.post(
    "/{chat_id}/invite-links", response_model=SuccessResponse[InviteLinkResponse]
)
async def create_invite_link(
    data: CreateInviteLinkRequest,
    chat_id: uuid.UUID = Path(..., description="Chat ID"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    await enforce_rate_limit(
        redis,
        scope="invite-link-create",
        identifier=str(user.id),
        limit=INVITE_MANAGE_LIMIT,
        window_seconds=INVITE_MANAGE_WINDOW,
        message="Too many invite links created. Please wait and try again.",
    )

    await _require_manage_rank(db, user.id, chat_id)

    link = await invite_link_services.create_invite_link(
        db, chat_id, user.id, data.expires_at, data.max_uses
    )

    await audit.record(
        mongo_db,
        AuditEvent.INVITE_LINK_CREATED,
        user_id=user.id,
        chat_id=chat_id,
        details={"invite_link_id": str(link.id)},
    )

    return SuccessResponse(data=link)


@chat_scoped_router.get(
    "/{chat_id}/invite-links", response_model=SuccessResponse[list[InviteLinkResponse]]
)
async def list_invite_links(
    chat_id: uuid.UUID = Path(..., description="Chat ID"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    await enforce_rate_limit(
        redis,
        scope="invite-link-list",
        identifier=str(user.id),
        limit=INVITE_LIST_LIMIT,
        window_seconds=INVITE_LIST_WINDOW,
        message="Too many invite-link lookups. Please wait and try again.",
    )

    await _require_manage_rank(db, user.id, chat_id)

    links = await invite_link_services.list_active_invite_links(db, chat_id)
    return SuccessResponse(data=links)


@router.post("/{token}/revoke", response_model=SuccessResponse[InviteLinkResponse])
async def revoke_invite_link(
    token: str = Path(..., min_length=1, max_length=128),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    """Revoke a link. Scoped to the chat it belongs to, not "any admin of any chat" — the caller
    must be ADMIN/OWNER of *that specific* chat, resolved from the link itself rather than trusted
    from the request."""
    await enforce_rate_limit(
        redis,
        scope="invite-link-revoke",
        identifier=str(user.id),
        limit=INVITE_MANAGE_LIMIT,
        window_seconds=INVITE_MANAGE_WINDOW,
        message="Too many invite-link changes. Please wait and try again.",
    )

    existing = await invite_link_services.get_invite_link_by_token(db, token)
    if existing is None:
        raise AppException(404, "NOT_FOUND", "Invite link not found.")

    await _require_manage_rank(db, user.id, existing.chat_id)

    link = await invite_link_services.revoke_invite_link(db, existing.chat_id, token)

    await audit.record(
        mongo_db,
        AuditEvent.INVITE_LINK_REVOKED,
        user_id=user.id,
        chat_id=existing.chat_id,
        details={"invite_link_id": str(link.id)},
    )

    return SuccessResponse(data=link)


@router.get("/{token}", response_model=SuccessResponse[InviteLinkPreviewResponse])
async def preview_invite_link(
    token: str = Path(..., min_length=1, max_length=128),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Preview a chat by invite-link token, without requiring membership and without exposing the
    roster. Requires authentication like every other endpoint here — this app has no anonymous
    accounts, and the client is single-origin behind cookie auth, so there is no route by which an
    unauthenticated request could reach this anyway."""
    await enforce_rate_limit(
        redis,
        scope="invite-link-preview",
        identifier=str(user.id),
        limit=INVITE_GUESS_LIMIT,
        window_seconds=INVITE_GUESS_WINDOW,
        message="Too many invite-link lookups. Please wait and try again.",
    )

    chat, member_count = await invite_link_services.preview_invite_link(db, token)

    return SuccessResponse(
        data=InviteLinkPreviewResponse(
            chat_id=chat.id,
            chat_type=chat.chat_type,
            title=chat.title,
            avatar_url=chat.avatar_url,
            member_count=member_count,
        )
    )


@router.post("/{token}/join", response_model=SuccessResponse[InviteLinkJoinResponse])
async def join_invite_link(
    token: str = Path(..., min_length=1, max_length=128),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    """Join the chat an invite link points at.

    Goes through `chat_services.add_chat_participants` — the same function `POST
    /chats/{id}/add-participants` uses — so the encrypted-group member cap and the mandatory
    epoch rotation on membership change apply identically here. See
    `invite_link_services.join_via_invite_link` for how token consumption and the add are made
    atomic.
    """
    await enforce_rate_limit(
        redis,
        scope="invite-link-join",
        identifier=str(user.id),
        limit=INVITE_GUESS_LIMIT,
        window_seconds=INVITE_GUESS_WINDOW,
        message="Too many join attempts. Please wait and try again.",
    )

    chat_id, already_member, epoch = await invite_link_services.join_via_invite_link(
        db, mongo_db, token, user.id
    )

    if not already_member:
        await _announce_epoch(db, redis, chat_id, epoch)

        participant_ids = list(
            await chat_services.get_chat_participants_ids(db, chat_id)
        )
        await redis_service.send_participants_added(
            redis,
            chat_id=chat_id,
            added_ids=[user.id],
            recipient_ids=participant_ids,
        )

        # The token itself is never logged (it is a credential) — only the chat and the joining
        # user, same as `PARTICIPANTS_ADDED`.
        await audit.record(
            mongo_db,
            AuditEvent.INVITE_LINK_JOINED,
            user_id=user.id,
            chat_id=chat_id,
            details={},
        )

    return SuccessResponse(
        data=InviteLinkJoinResponse(chat_id=chat_id, already_member=already_member)
    )
