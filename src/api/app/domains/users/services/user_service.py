import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from app.core.exceptions import AppException
from app.core.security import get_password_hash
from app.domains.users.models.user import User
from app.domains.users.schemas.user_schemas import UserCreate


async def get_user_by_id(db: AsyncSession, user_id: uuid.UUID) -> User | None:
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()


async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()


async def get_user_by_phone(db: AsyncSession, phone_number: str) -> User | None:
    result = await db.execute(select(User).where(User.phone_number == phone_number))
    return result.scalar_one_or_none()


async def get_user_by_email_and_username(db: AsyncSession, username: str, email: str) -> User | None:
    result = await db.execute(select(User).where(User.username == username, User.email == email))
    return result.scalar_one_or_none()


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    result = await db.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


async def find_users_by_username(db: AsyncSession, username: str,
                                 current_user_id: uuid.UUID, limit: int) -> (list[User] | None):
    stmt = (
        select(User)
        .where(
            User.username.ilike(f"%{username}%"),
            User.id != current_user_id
        )
        .limit(limit)
    )
    results = await db.execute(stmt)
    return results.scalars().all()


async def get_users_by_ids(db: AsyncSession, user_ids: list[uuid.UUID]) -> list[User]:
    """Look up several users at once.

    Ids that do not exist are simply absent from the result rather than raising — a caller resolving
    a roster should not fail wholesale because one member's account was deleted.
    """
    stmt = select(User).where(User.id.in_(set(user_ids)))
    results = await db.execute(stmt)
    return list(results.scalars().all())


async def create_user(db: AsyncSession, user_in: UserCreate) -> User | None:
    existing_user = await get_user_by_username(db, user_in.username)
    if existing_user:
        raise AppException(
            status_code=status.HTTP_400_BAD_REQUEST,
            error_code="USER_ALREADY_EXISTS",
            message="User with that username already exists."
        )

    user_dict = {
        **user_in.model_dump(exclude={"password"}),
        "hashed_password": get_password_hash(user_in.password)
    }

    user = User(**user_dict)

    db.add(user)
    await db.commit()
    await db.refresh(user)

    return user
