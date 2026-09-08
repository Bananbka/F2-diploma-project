import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import AppException
from app.domains.chats.models import Contact
from app.domains.users.models import User


async def add_user_to_contacts(
        db: AsyncSession,
        owner_id: uuid.UUID,
        target_id: uuid.UUID,
        alias: str | None = None,
) -> Contact:
    if owner_id == target_id:
        raise AppException(400, "INVALID_CONTACT_ID", "You cannot add yourself as contact.")

    target_user = await db.get(User, target_id)
    if not target_user:
        raise AppException(404, "USER_NOT_FOUND", "User not found.")

    stmt = (
        select(Contact)
        .where(
            Contact.owner_id == owner_id,
            Contact.contact_id == target_id,
        )
    )
    existing_contact = await db.scalar(stmt)

    if existing_contact:
        existing_contact.alias_name = alias
        await db.commit()
        await db.refresh(existing_contact)
        return existing_contact

    new_contact = Contact(
        owner_id=owner_id,
        contact_id=target_id,
        alias_name=alias
    )
    db.add(new_contact)
    await db.commit()
    await db.refresh(new_contact)

    return new_contact


async def get_user_contacts(db: AsyncSession, owner_id: uuid.UUID) -> list[Contact]:
    stmt = (
        select(Contact)
        .where(Contact.owner_id == owner_id)
        .options(selectinload(Contact.user))
    )
    res = await db.execute(stmt)
    return res.scalars().all()