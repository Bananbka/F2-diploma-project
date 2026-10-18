import uuid

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import AppException
from app.domains.stickers.models import Sticker
from app.domains.stickers.schemas.sticker_schemas import StickerCreateRequest
from app.domains.stickers.services.sticker_pack_service import (
    MAX_STICKERS_PER_PACK,
    get_owned_pack_or_403,
)
from app.infrastructure.minio import minio_manager


async def add_sticker(
    db: AsyncSession,
    pack_id: uuid.UUID,
    owner_id: uuid.UUID,
    data: StickerCreateRequest,
) -> Sticker:
    await get_owned_pack_or_403(db, pack_id, owner_id)

    current_count = await db.scalar(
        select(func.count()).select_from(Sticker).where(Sticker.pack_id == pack_id)
    )
    if current_count >= MAX_STICKERS_PER_PACK:
        raise AppException(
            400,
            "STICKER_LIMIT_REACHED",
            f"A sticker pack can hold at most {MAX_STICKERS_PER_PACK} stickers.",
        )

    position = data.position
    if position is None:
        max_position = await db.scalar(
            select(func.max(Sticker.position)).where(Sticker.pack_id == pack_id)
        )
        position = 0 if max_position is None else max_position + 1

    sticker = Sticker(
        pack_id=pack_id,
        image_url=data.image_url,
        emoji=data.emoji,
        position=position,
    )
    db.add(sticker)
    await db.commit()
    await db.refresh(sticker)
    return sticker


async def _get_sticker_in_owned_pack(
    db: AsyncSession, pack_id: uuid.UUID, sticker_id: uuid.UUID, owner_id: uuid.UUID
) -> Sticker:
    sticker = (
        await db.execute(select(Sticker).where(Sticker.id == sticker_id))
    ).scalar_one_or_none()

    if sticker is None:
        raise AppException(404, "STICKER_NOT_FOUND", "That sticker does not exist.")

    # The route is `/packs/{pack_id}/stickers/{sticker_id}`; without this, a `pack_id` naming a
    # different pack the caller also owns would silently succeed against the sticker's real pack,
    # which is a confusing contract even though it is not an access-control bypass.
    if sticker.pack_id != pack_id:
        raise AppException(404, "STICKER_NOT_FOUND", "That sticker does not exist.")

    await get_owned_pack_or_403(db, sticker.pack_id, owner_id)
    return sticker


async def delete_sticker(
    db: AsyncSession, pack_id: uuid.UUID, sticker_id: uuid.UUID, owner_id: uuid.UUID
) -> None:
    sticker = await _get_sticker_in_owned_pack(db, pack_id, sticker_id, owner_id)

    await minio_manager.delete_file(sticker.image_url, settings.MINIO_STICKER_BUCKET)

    await db.delete(sticker)
    await db.commit()


async def reorder_stickers(
    db: AsyncSession,
    pack_id: uuid.UUID,
    owner_id: uuid.UUID,
    ordered_sticker_ids: list[uuid.UUID],
) -> None:
    await get_owned_pack_or_403(db, pack_id, owner_id)

    existing_ids = set(
        (
            await db.execute(select(Sticker.id).where(Sticker.pack_id == pack_id))
        ).scalars().all()
    )

    if set(ordered_sticker_ids) != existing_ids:
        raise AppException(
            400,
            "STICKER_SET_MISMATCH",
            "The given sticker ids must be exactly the stickers currently in this pack.",
        )

    for position, sticker_id in enumerate(ordered_sticker_ids):
        await db.execute(
            update(Sticker)
            .where(Sticker.id == sticker_id, Sticker.pack_id == pack_id)
            .values(position=position)
        )

    await db.commit()
