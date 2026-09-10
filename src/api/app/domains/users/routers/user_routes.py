from fastapi import APIRouter, Depends, Query, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.core.responses import SuccessResponse
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.domains.users.schemas.user_schemas import UserBatchRequest, UserSearchResponse
from app.domains.users.services import user_service
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis

router = APIRouter(prefix="/users", tags=["Users"])

# Directory reads are cheap individually and dangerous in bulk: search enumerates usernames and
# the phone branch of the lookup below maps numbers to accounts.
LOOKUP_WINDOW = 60
LOOKUP_PER_WINDOW = 60
SEARCH_PER_WINDOW = 60


@router.get("/search", response_model=SuccessResponse[list[UserSearchResponse]])
async def search_users(
        query: str = Query(..., min_length=1, max_length=50, description="Search query for username"),
        limit: int = Query(20, ge=1, le=50),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis),
):
    await enforce_rate_limit(
        redis, scope="user-search", identifier=str(user.id),
        limit=SEARCH_PER_WINDOW, window_seconds=LOOKUP_WINDOW,
        message="Too many searches. Please slow down.",
    )

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


@router.get("/{query}", response_model=SuccessResponse[UserSearchResponse])
async def find_user(query: str, request: Request,
                    user: User = Depends(get_current_user),
                    db: AsyncSession = Depends(get_db),
                    redis: Redis = Depends(get_redis)):
    """Look one user up by exact username, or by phone number when the query starts with `+`.

    Returns the **public** projection only. This used to return the full `UserResponse`, which
    carries `email` and `phone_number` — so any signed-in account could walk the usernames out of
    `/users/search` and harvest the email address and phone number of every registered user. That
    directly contradicted the rule stated on `/users/batch`: being able to find someone must not
    disclose more about them than searching for them would.

    Rate limited because the phone branch is a reverse-lookup oracle. Without a limit, an attacker
    can walk a number range and map phone numbers to accounts.
    """
    await enforce_rate_limit(
        redis, scope="user-lookup", identifier=str(user.id),
        limit=LOOKUP_PER_WINDOW, window_seconds=LOOKUP_WINDOW,
        message="Too many lookups. Please slow down.",
    )

    user_data = (
        await user_service.get_user_by_phone(db, query)
        if query.startswith("+")
        else await (user_service.get_user_by_username(db, query))
    )

    if not user_data:
        raise AppException(404, "USER_NOT_FOUND", "User not found.")
    return SuccessResponse(data=user_data)
