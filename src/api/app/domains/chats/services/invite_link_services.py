"""Invite-link lifecycle: creation, listing, revocation, preview and join.

The join path deliberately does not duplicate `chat_services.add_chat_participants` — it calls it.
That function already enforces the encrypted-group member cap (`MAX_E2E_GROUP_MEMBERS`) and
triggers the mandatory epoch rotation on membership change; a second insertion path here would be
exactly the kind of divergent join flow that risks skipping one of those. See `join_via_invite_link`
below for how the two are composed in one transaction.
"""

import secrets
import uuid
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.domains.chats.models import Chat, ChatInviteLink, ChatParticipant, ChatType
from app.domains.chats.services import chat_services
from app.domains.crypto.models import ChatKeyEpoch
from app.domains.messages.services import messages_service

# Sized well beyond what any brute-force is remotely close to reaching: 32 raw bytes is 256 bits
# of entropy, `token_urlsafe` renders that as ~43 base64url characters. `secrets` is a CSPRNG;
# `random` is not and must never be used for anything that stands in for a credential.
TOKEN_BYTES = 32


def _generate_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def _is_active(link: ChatInviteLink, now: datetime) -> bool:
    if link.revoked_at is not None:
        return False
    if link.expires_at is not None and link.expires_at <= now:
        return False
    if link.max_uses is not None and link.use_count >= link.max_uses:
        return False
    return True


async def create_invite_link(
    db: AsyncSession,
    chat_id: uuid.UUID,
    created_by: uuid.UUID,
    expires_at: datetime | None,
    max_uses: int | None,
) -> ChatInviteLink:
    link = ChatInviteLink(
        chat_id=chat_id,
        created_by=created_by,
        token=_generate_token(),
        expires_at=expires_at,
        max_uses=max_uses,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)
    return link


async def list_active_invite_links(
    db: AsyncSession, chat_id: uuid.UUID
) -> list[ChatInviteLink]:
    now = datetime.now(timezone.utc)
    stmt = (
        select(ChatInviteLink)
        .where(
            ChatInviteLink.chat_id == chat_id,
            ChatInviteLink.revoked_at.is_(None),
            or_(ChatInviteLink.expires_at.is_(None), ChatInviteLink.expires_at > now),
            or_(
                ChatInviteLink.max_uses.is_(None),
                ChatInviteLink.use_count < ChatInviteLink.max_uses,
            ),
        )
        .order_by(ChatInviteLink.created_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def get_invite_link_by_token(
    db: AsyncSession, token: str
) -> ChatInviteLink | None:
    stmt = select(ChatInviteLink).where(ChatInviteLink.token == token)
    return (await db.execute(stmt)).scalar_one_or_none()


async def revoke_invite_link(
    db: AsyncSession, chat_id: uuid.UUID, token: str
) -> ChatInviteLink:
    """Revoke a link, scoped to the chat it was checked to belong to.

    The router resolves the link, confirms `link.chat_id == chat_id` and the caller's rank in
    *that* chat before calling this — an admin of one chat must not be able to revoke a link
    belonging to another chat by guessing/reusing a token, so scoping happens before this, not
    just as a `WHERE` clause here that could silently no-op.
    """
    stmt = (
        update(ChatInviteLink)
        .where(ChatInviteLink.token == token, ChatInviteLink.chat_id == chat_id)
        .values(revoked_at=func.now())
        .returning(ChatInviteLink)
    )
    res = await db.execute(stmt)
    link = res.scalar_one_or_none()
    if link is None:
        raise AppException(404, "NOT_FOUND", "Invite link not found.")

    await db.commit()
    return link


async def preview_invite_link(db: AsyncSession, token: str) -> tuple[Chat, int]:
    """Resolve a token to (chat, member_count) for the preview endpoint, without exposing the
    roster. Raises 404 for a token that never existed and 410 for one that did but is dead.

    The 404/410 split does leak "this token existed" versus "it never did" to whoever holds it —
    but the token space is 256 bits, so anyone in a position to notice that distinction already
    holds a specific, unguessable token; the split costs nothing extra to an attacker who cannot
    already produce valid tokens, and it lets the preview screen tell "wrong link" apart from
    "link expired" for a legitimate holder. The *specific* reason (expired vs. revoked vs.
    exhausted) is deliberately not distinguished beyond that split, since none of those change
    what the user should do next.
    """
    link = await get_invite_link_by_token(db, token)
    if link is None:
        raise AppException(404, "NOT_FOUND", "Invite link not found.")

    if not _is_active(link, datetime.now(timezone.utc)):
        raise AppException(410, "INVITE_LINK_GONE", "This invite link is no longer valid.")

    chat = await chat_services.get_chat_by_id(db, link.chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Invite link not found.")

    member_count = await db.scalar(
        select(func.count())
        .select_from(ChatParticipant)
        .where(ChatParticipant.chat_id == chat.id)
    )
    return chat, member_count


async def _consume(db: AsyncSession, token: str) -> ChatInviteLink | None:
    """Atomically validate-and-increment one use of a link, in a single statement.

    A read-then-write ("read use_count, check < max_uses, then write use_count + 1") lets two
    concurrent joins on a link with exactly one use left both read the same pre-increment value,
    both pass the check, and both write — overshooting `max_uses` by one, mirroring the group-cap
    race this codebase already fixed once for `add_chat_participants`. Folding the check into the
    `UPDATE`'s `WHERE` clause instead means Postgres re-evaluates that clause (under
    `EvalPlanQual`, since this runs at the default READ COMMITTED level) against the row's
    just-committed value once the first transaction's lock is released, so at most one of the two
    concurrent updates can match and return a row.
    """
    now = datetime.now(timezone.utc)
    stmt = (
        update(ChatInviteLink)
        .where(
            ChatInviteLink.token == token,
            ChatInviteLink.revoked_at.is_(None),
            or_(ChatInviteLink.expires_at.is_(None), ChatInviteLink.expires_at > now),
            or_(
                ChatInviteLink.max_uses.is_(None),
                ChatInviteLink.use_count < ChatInviteLink.max_uses,
            ),
        )
        .values(use_count=ChatInviteLink.use_count + 1)
        .returning(ChatInviteLink)
    )
    res = await db.execute(stmt)
    return res.scalar_one_or_none()


async def join_via_invite_link(
    db: AsyncSession,
    mongo_db: AsyncIOMotorDatabase,
    token: str,
    user_id: uuid.UUID,
) -> tuple[uuid.UUID, bool, "ChatKeyEpoch | None", uuid.UUID]:
    """Join the chat an invite link points at.

    Returns `(chat_id, already_member, epoch, invite_link_id)`. The link id is returned alongside
    the rest so the caller can put it on the `INVITE_LINK_JOINED` audit record — symmetric with
    `INVITE_LINK_CREATED`/`INVITE_LINK_REVOKED`, both of which already carry it — so an
    investigator can tell which specific link a join used when a chat has more than one active.

    Already-a-member is checked *before* touching the link at all, so rejoining through a link
    never consumes one of its limited uses and never fails on an expired/revoked/exhausted link —
    from an existing member's perspective, following the link again is a harmless no-op regardless
    of what has since happened to the link itself.

    For a new joiner, `_consume` and `chat_services.add_chat_participants` run on the same
    session without an intermediate commit, so they land in one transaction: if the member cap
    (enforced inside `add_chat_participants`) rejects the join, the `use_count` increment is
    never committed either, and `get_db`'s session-close rolls it back. A join must never burn a
    link's use on a failed attempt.
    """
    link = await get_invite_link_by_token(db, token)
    if link is None:
        raise AppException(404, "NOT_FOUND", "Invite link not found.")

    chat = await chat_services.get_chat_by_id(db, link.chat_id)
    if chat is None:
        raise AppException(404, "NOT_FOUND", "Invite link not found.")

    if await messages_service.is_user_in_chat(db, user_id, chat.id) is not None:
        return chat.id, True, None, link.id

    consumed = await _consume(db, token)
    if consumed is None:
        raise AppException(410, "INVITE_LINK_GONE", "This invite link is no longer valid.")

    # `chat.chat_type` is guaranteed GROUP/CHANNEL by construction — invite links can only be
    # created for those (see the router) — but a private chat has exactly two fixed participants
    # and no admin/owner concept at all, so this is re-checked defensively rather than trusted.
    if chat.chat_type == ChatType.PRIVATE:
        raise AppException(
            400, "INVALID_CHAT_TYPE", "This chat cannot be joined via an invite link."
        )

    _, epoch = await chat_services.add_chat_participants(
        db, chat.id, [user_id], mongo_db=mongo_db
    )
    return chat.id, False, epoch, link.id
