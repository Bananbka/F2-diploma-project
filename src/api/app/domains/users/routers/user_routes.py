from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.responses import SuccessResponse
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.domains.users.schemas.user_schemas import UserBatchRequest, UserSearchResponse, UserResponse
from app.domains.users.services import user_service
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/users", tags=["Users"])


@router.get("/search", response_model=SuccessResponse[list[UserSearchResponse]])
async def search_users(
        query: str = Query(..., min_length=1, description="Search query for username"),
        limit: int = Query(20, ge=1, le=50),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    users = await user_service.find_users_by_username(db, query, user.id, limit)
    return SuccessResponse(data=users)


@router.post("/batch", response_model=SuccessResponse[list[UserSearchResponse]])
async def get_users_batch(
        data: UserBatchRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
):
    """Resolve user ids to display names, mirroring POST /crypto/keys/batch.

    Nothing else could do this: `GET /users/{query}` matches username or phone, the chat participant
    list carries only ids and roles, and the crypto roster carries only keys. Without it a client can
    name contacts and private-chat counterparts but not other group members, who then render as a
    truncated uuid.

    Only the public search projection is returned — no email, no phone — because being in a chat with
    someone should not disclose more about them than searching for them would.
    """
    users = await user_service.get_users_by_ids(db, data.user_ids)
    return SuccessResponse(data=users, meta={"count": len(users)})


@router.get("/{query}", response_model=SuccessResponse[UserResponse])
async def find_user(query: str, user: User = Depends(get_current_user),
                    db: AsyncSession = Depends(get_db)):
    user_data = (
        await user_service.get_user_by_phone(db, query)
        if query.startswith("+")
        else await (user_service.get_user_by_username(db, query))
    )

    if not user_data:
        raise AppException(404, "USER_NOT_FOUND", "User not found.")
    return SuccessResponse(data=user_data)
