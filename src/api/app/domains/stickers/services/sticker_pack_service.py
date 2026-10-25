import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.exceptions import AppException
from app.domains.stickers.models import Sticker, StickerPack, StickerPackSubscription
from app.domains.stickers.schemas.sticker_schemas import (
    StickerPackSummary,
    StickerPackUpdateRequest,
)
from app.infrastructure.minio import minio_manager

# Caps mirror the encrypted-group caps elsewhere in this codebase: generous enough for ordinary
# use, small enough that a single account cannot turn this into unbounded storage.
MAX_PACKS_PER_USER = 50
MAX_STICKERS_PER_PACK = 120


async def create_pack(db: AsyncSession, owner_id: uuid.UUID, title: str) -> StickerPack:
    current_count = await db.scalar(
        select(func.count()).select_from(StickerPack).where(StickerPack.owner_id == owner_id)
    )
    if current_count >= MAX_PACKS_PER_USER:
        raise AppException(
            400,
            "PACK_LIMIT_REACHED",
            f"You can own at most {MAX_PACKS_PER_USER} sticker packs.",
        )

    pack = StickerPack(owner_id=owner_id, title=title)
    db.add(pack)
    await db.commit()
    await db.refresh(pack, attribute_names=["stickers"])
    return pack


async def _get_pack(db: AsyncSession, pack_id: uuid.UUID) -> StickerPack | None:
    stmt = (
        select(StickerPack)
        .where(StickerPack.id == pack_id)
        .options(selectinload(StickerPack.stickers))
    )
    res = await db.execute(stmt)
    return res.scalar_one_or_none()


async def get_pack_or_403(
    db: AsyncSession, pack_id: uuid.UUID, user_id: uuid.UUID
) -> StickerPack:
    """Read-access chokepoint: owner or public. 404 if the pack does not exist at all."""
    pack = await _get_pack(db, pack_id)
    if pack is None:
        raise AppException(404, "PACK_NOT_FOUND", "That sticker pack does not exist.")

    if pack.owner_id != user_id and not pack.is_public:
        raise AppException(403, "ACCESS_DENIED", "That sticker pack is private.")

    return pack


async def get_pack_by_sticker_url(
    db: AsyncSession, url: str, user_id: uuid.UUID
) -> StickerPack:
    """Resolve the pack owning the sticker stored under `url`, for a viewer who may see it:
    owner, public, or subscribed. Unknown url and not-visible both raise the same 404, so the
    endpoint cannot be used to probe whether a private pack's sticker exists."""
    unavailable = AppException(
        404, "STICKER_PACK_UNAVAILABLE", "That sticker pack is not available."
    )
    pack_id = (
        await db.execute(select(Sticker.pack_id).where(Sticker.image_url == url).limit(1))
    ).scalar_one_or_none()
    if pack_id is None:
        raise unavailable

    pack = await _get_pack(db, pack_id)
    if pack is None:
        raise unavailable

    if pack.owner_id != user_id and not pack.is_public:
        subscribed = await db.scalar(
            select(StickerPackSubscription.pack_id).where(
                StickerPackSubscription.user_id == user_id,
                StickerPackSubscription.pack_id == pack_id,
            )
        )
        if subscribed is None:
            raise unavailable

    return pack


async def get_owned_pack_or_403(
    db: AsyncSession, pack_id: uuid.UUID, user_id: uuid.UUID
) -> StickerPack:
    """Mutation chokepoint: owner only, public or not."""
    pack = await _get_pack(db, pack_id)
    if pack is None:
        raise AppException(404, "PACK_NOT_FOUND", "That sticker pack does not exist.")

    if pack.owner_id != user_id:
        raise AppException(
            403, "ACCESS_DENIED", "Only the owner can modify this sticker pack."
        )

    return pack


async def update_pack(
    db: AsyncSession,
    pack_id: uuid.UUID,
    owner_id: uuid.UUID,
    data: StickerPackUpdateRequest,
) -> StickerPack:
    pack = await get_owned_pack_or_403(db, pack_id, owner_id)

    update_data = data.model_dump(exclude_unset=True)

    # Both columns are NOT NULL. `title`/`is_public` are optional only to distinguish "omitted"
    # from "provided" via `exclude_unset`; an explicit `null` is a client mistake, not an
    # instruction to clear the column, and must not reach `setattr` -> commit as an unhandled
    # IntegrityError. Mirrors the identical guard on `PATCH /profile/me`.
    if update_data.get("title", "") is None:
        raise AppException(
            400, "INVALID_TITLE", "Title cannot be cleared; omit the field instead."
        )
    if update_data.get("is_public", False) is None:
        raise AppException(
            400,
            "INVALID_IS_PUBLIC",
            "is_public cannot be cleared; omit the field instead.",
        )

    for field, value in update_data.items():
        setattr(pack, field, value)

    await db.commit()
    await db.refresh(pack, attribute_names=["stickers"])
    return pack


async def delete_pack(db: AsyncSession, pack_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    """Owner-only. Stickers always have an explicit delete path, so no Celery GC is needed: the
    MinIO objects are removed synchronously before the row (and its cascade) go away."""
    pack = await get_owned_pack_or_403(db, pack_id, owner_id)

    for sticker in pack.stickers:
        await minio_manager.delete_file(sticker.image_url, settings.MINIO_STICKER_BUCKET)

    await db.delete(pack)
    await db.commit()


async def list_my_tray(db: AsyncSession, user_id: uuid.UUID) -> list[StickerPackSummary]:
    """Packs the user owns, union packs they have subscribed to."""
    owned_ids = (
        await db.execute(select(StickerPack.id).where(StickerPack.owner_id == user_id))
    ).scalars().all()
    subscribed_ids = (
        await db.execute(
            select(StickerPackSubscription.pack_id).where(
                StickerPackSubscription.user_id == user_id
            )
        )
    ).scalars().all()

    pack_ids = list(set(owned_ids) | set(subscribed_ids))
    if not pack_ids:
        return []

    return await _summaries_for(db, pack_ids)


async def list_public_packs(
    db: AsyncSession, search: str | None, limit: int, offset: int
) -> list[StickerPackSummary]:
    stmt = select(StickerPack.id).where(StickerPack.is_public.is_(True))
    if search:
        stmt = stmt.where(StickerPack.title.ilike(f"%{search}%"))
    stmt = stmt.order_by(StickerPack.created_at.desc()).limit(limit).offset(offset)

    pack_ids = (await db.execute(stmt)).scalars().all()
    if not pack_ids:
        return []

    return await _summaries_for(db, pack_ids)


async def _summaries_for(
    db: AsyncSession, pack_ids: list[uuid.UUID]
) -> list[StickerPackSummary]:
    """Build summaries for a known set of pack ids with a fixed, small number of queries —
    one for the pack rows, one for counts, one for covers — rather than one per pack."""
    packs = (
        await db.execute(select(StickerPack).where(StickerPack.id.in_(pack_ids)))
    ).scalars().all()

    counts = dict(
        (
            await db.execute(
                select(Sticker.pack_id, func.count())
                .where(Sticker.pack_id.in_(pack_ids))
                .group_by(Sticker.pack_id)
            )
        ).all()
    )

    covers = dict(
        (
            await db.execute(
                select(Sticker.pack_id, Sticker.image_url).where(
                    Sticker.pack_id.in_(pack_ids), Sticker.position == 0
                )
            )
        ).all()
    )

    return [
        StickerPackSummary(
            id=pack.id,
            owner_id=pack.owner_id,
            title=pack.title,
            is_public=pack.is_public,
            sticker_count=counts.get(pack.id, 0),
            cover_image_url=covers.get(pack.id),
        )
        for pack in packs
    ]


async def subscribe(db: AsyncSession, pack_id: uuid.UUID, user_id: uuid.UUID) -> None:
    pack = await _get_pack(db, pack_id)
    if pack is None:
        raise AppException(404, "PACK_NOT_FOUND", "That sticker pack does not exist.")

    if not pack.is_public:
        raise AppException(400, "PACK_NOT_PUBLIC", "That sticker pack is not public.")

    stmt = (
        postgresql.insert(StickerPackSubscription)
        .values(user_id=user_id, pack_id=pack_id)
        .on_conflict_do_nothing(index_elements=["user_id", "pack_id"])
    )
    await db.execute(stmt)
    await db.commit()


async def unsubscribe(db: AsyncSession, pack_id: uuid.UUID, user_id: uuid.UUID) -> None:
    await db.execute(
        delete(StickerPackSubscription).where(
            StickerPackSubscription.pack_id == pack_id,
            StickerPackSubscription.user_id == user_id,
        )
    )
    await db.commit()
