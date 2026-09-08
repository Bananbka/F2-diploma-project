import uuid

from sqlalchemy import select, func, insert, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import AppException
from app.domains.chats.models import ChatParticipant, ChatFolder, FolderItem
from app.domains.chats.schemas.folder_schemas import FolderCreateRequest
from app.domains.messages.services.messages_service import is_user_in_all_chats


async def get_count_of_available_chats(db: AsyncSession, user_id: uuid.UUID, chat_ids: list[uuid.UUID]) -> int:
    stmt = select(func.count()).select_from(ChatParticipant).where(
        ChatParticipant.chat_id.in_(chat_ids),
        ChatParticipant.user_id == user_id
    )
    res = await db.execute(stmt)
    return res.scalar_one()


async def create_folder(db: AsyncSession, user_id: uuid.UUID, data: FolderCreateRequest) -> ChatFolder:
    folder = ChatFolder(user_id=user_id, title=data.title)
    db.add(folder)
    await db.flush()

    chat_ids = set(data.chat_ids)
    items_to_create = [{"chat_id": chat_id, "folder_id": folder.id} for chat_id in chat_ids]

    if items_to_create:
        await db.execute(insert(FolderItem), items_to_create)

    await db.commit()

    await db.refresh(folder, attribute_names=['items'])
    return folder


async def get_folder(db: AsyncSession, user_id: uuid.UUID, folder_id: uuid.UUID) -> ChatFolder | None:
    stmt = (
        select(ChatFolder)
        .where(ChatFolder.id == folder_id, ChatFolder.user_id == user_id)
        .options(selectinload(ChatFolder.items))
    )
    res = await db.execute(stmt)
    folder = res.scalar_one_or_none()

    return folder


async def get_folders(db: AsyncSession, user_id: uuid.UUID) -> list[ChatFolder]:
    stmt = (
        select(ChatFolder)
        .where(ChatFolder.user_id == user_id)
        .options(selectinload(ChatFolder.items))
        .order_by(ChatFolder.created_at.asc())
    )
    res = await db.execute(stmt)
    return res.scalars().all()


async def update_folder(db: AsyncSession, user_id: uuid.UUID, folder: ChatFolder, update_data: dict) -> ChatFolder:
    if 'title' in update_data:
        folder.title = update_data['title']

    if 'chat_ids' in update_data:
        current_chat_ids = {item.chat_id for item in folder.items}
        new_chat_ids = set(update_data['chat_ids'])

        if not await is_user_in_all_chats(db, user_id, new_chat_ids):
            raise AppException(403, "FORBIDDEN", "You don't have permission to access some of chats")

        to_add = new_chat_ids - current_chat_ids
        to_delete = current_chat_ids - new_chat_ids

        if to_delete:
            await db.execute(
                delete(FolderItem).where(
                    FolderItem.folder_id == folder.id,
                    FolderItem.chat_id.in_(to_delete)
                )
            )

        if to_add:
            items_to_create = [
                {"chat_id": chat_id, "folder_id": folder.id}
                for chat_id in to_add
            ]
            await db.execute(insert(FolderItem), items_to_create)

    await db.commit()

    await db.refresh(folder, attribute_names=['items'])

    return folder


async def delete_folder(db: AsyncSession, user_id: uuid.UUID, folder_id: uuid.UUID) -> int:
    stmt = delete(ChatFolder).where(
        ChatFolder.id == folder_id,
        ChatFolder.user_id == user_id
    )

    res = await db.execute(stmt)

    await db.commit()

    return res.rowcount
