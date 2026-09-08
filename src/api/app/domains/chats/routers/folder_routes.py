import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.responses import SuccessResponse
from app.domains.chats.schemas.folder_schemas import FolderResponse, FolderCreateRequest, FolderUpdateRequest
from app.domains.chats.services import folder_services
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/chat-folder", tags=["Folders"])


@router.post("/", response_model=SuccessResponse[FolderResponse])
async def create_folder(
        data: FolderCreateRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    cp = await folder_services.get_count_of_available_chats(db, user.id, data.chat_ids)

    if cp != len(data.chat_ids):
        raise AppException(403, "FORBIDDEN", "You don't have permission to access some of chats")

    folder = await folder_services.create_folder(db, user.id, data)

    return SuccessResponse(data=folder)


@router.get("/{folder_id}", response_model=SuccessResponse[FolderResponse])
async def get_folder(
        folder_id: uuid.UUID,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    folder = await folder_services.get_folder(db, user.id, folder_id)

    if folder is None:
        raise AppException(404, "NOT_FOUND", "There is no your folders with such id.")

    return SuccessResponse(data=folder)


@router.get("/", response_model=SuccessResponse[list[FolderResponse]])
async def get_folders(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    folders = await folder_services.get_folders(db, user.id)
    return SuccessResponse(data=folders)


@router.patch("/{folder_id}", response_model=SuccessResponse[FolderResponse])
async def update_folder(
        folder_id: uuid.UUID,
        data: FolderUpdateRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    update_data = data.model_dump(exclude_unset=True)

    folder = await folder_services.get_folder(db, user.id, folder_id)

    if folder is None:
        raise AppException(404, "NOT_FOUND", "There is no your folders with such id.")

    if not update_data:
        return SuccessResponse(data=folder)

    folder = await folder_services.update_folder(db, user.id, folder, update_data)

    return SuccessResponse(data=folder)


@router.delete("/{folder_id}", response_model=SuccessResponse[dict])
async def delete_folder(
        folder_id: uuid.UUID,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    rowcount = await folder_services.delete_folder(db, user.id, folder_id)

    if rowcount == 0:
        raise AppException(404, "NOT_FOUND", "There is no your folders with such id.")

    return SuccessResponse(data={"message": "Folder deleted"})
