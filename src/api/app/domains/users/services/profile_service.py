import uuid

from sqlalchemy import select, exists
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.users.models import User


async def is_username_taken(db: AsyncSession, username: str, current_user_id: uuid.UUID) -> bool:
    stmt = select(
        exists().where(
            User.username == username,
            User.id != current_user_id
        )
    )
    res = await db.execute(stmt)
    return res.scalar()
