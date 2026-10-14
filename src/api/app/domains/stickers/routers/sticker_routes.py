import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.responses import SuccessResponse
from app.domains.stickers.schemas.sticker_schemas import (
    StickerCreateRequest,
    StickerPackCreateRequest,
    StickerPackResponse,
    StickerPackSummary,
    StickerPackUpdateRequest,
    StickerResponse,
)
from app.domains.stickers.services import sticker_pack_service, sticker_service
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/stickers", tags=["Stickers"])


@router.post("/packs", response_model=SuccessResponse[StickerPackResponse])
async def create_pack(
    data: StickerPackCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pack = await sticker_pack_service.create_pack(db, user.id, data.title)
    return SuccessResponse(data=pack)


@router.get("/packs/mine", response_model=SuccessResponse[list[StickerPackSummary]])
async def list_my_tray(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    packs = await sticker_pack_service.list_my_tray(db, user.id)
    return SuccessResponse(data=packs)


@router.get("/packs/public", response_model=SuccessResponse[list[StickerPackSummary]])
async def list_public_packs(
    search: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    packs = await sticker_pack_service.list_public_packs(db, search, limit, offset)
    return SuccessResponse(data=packs)


@router.get("/packs/{pack_id}", response_model=SuccessResponse[StickerPackResponse])
async def get_pack(
    pack_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pack = await sticker_pack_service.get_pack_or_403(db, pack_id, user.id)
    return SuccessResponse(data=pack)


@router.patch("/packs/{pack_id}", response_model=SuccessResponse[StickerPackResponse])
async def update_pack(
    pack_id: uuid.UUID,
    data: StickerPackUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pack = await sticker_pack_service.update_pack(db, pack_id, user.id, data)
    return SuccessResponse(data=pack)


@router.delete("/packs/{pack_id}", response_model=SuccessResponse[dict])
async def delete_pack(
    pack_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await sticker_pack_service.delete_pack(db, pack_id, user.id)
    return SuccessResponse(data={"message": "Sticker pack deleted."})


@router.post("/packs/{pack_id}/stickers", response_model=SuccessResponse[StickerResponse])
async def add_sticker(
    pack_id: uuid.UUID,
    data: StickerCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sticker = await sticker_service.add_sticker(db, pack_id, user.id, data)
    return SuccessResponse(data=sticker)


@router.delete(
    "/packs/{pack_id}/stickers/{sticker_id}", response_model=SuccessResponse[dict]
)
async def delete_sticker(
    pack_id: uuid.UUID,
    sticker_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await sticker_service.delete_sticker(db, pack_id, sticker_id, user.id)
    return SuccessResponse(data={"message": "Sticker deleted."})


@router.put("/packs/{pack_id}/stickers/order", response_model=SuccessResponse[dict])
async def reorder_stickers(
    pack_id: uuid.UUID,
    ordered_sticker_ids: list[uuid.UUID],
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await sticker_service.reorder_stickers(db, pack_id, user.id, ordered_sticker_ids)
    return SuccessResponse(data={"message": "Sticker order updated."})


@router.post("/packs/{pack_id}/subscribe", response_model=SuccessResponse[dict])
async def subscribe_to_pack(
    pack_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await sticker_pack_service.subscribe(db, pack_id, user.id)
    return SuccessResponse(data={"message": "Subscribed to sticker pack."})


@router.delete("/packs/{pack_id}/subscribe", response_model=SuccessResponse[dict])
async def unsubscribe_from_pack(
    pack_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await sticker_pack_service.unsubscribe(db, pack_id, user.id)
    return SuccessResponse(data={"message": "Unsubscribed from sticker pack."})
