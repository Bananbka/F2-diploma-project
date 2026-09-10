from fastapi import APIRouter, Depends, Path
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.responses import SuccessResponse
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.domains.users.schemas.profile_schemas import ProfileRequestSchema
from app.domains.users.schemas.user_schemas import UserResponse
from app.domains.users.services.profile_service import is_username_taken
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/profile", tags=["Profile"])


@router.get("/me", response_model=SuccessResponse[UserResponse])
async def get_me(current_user: User = Depends(get_current_user)):
    return SuccessResponse(data=current_user)


@router.patch("/me", response_model=SuccessResponse[UserResponse])
async def change_me(data_in: ProfileRequestSchema, user: User = Depends(get_current_user),
                    db: AsyncSession = Depends(get_db)):
    update_data = data_in.model_dump(exclude_unset=True)
    if not update_data:
        return SuccessResponse(data=user)

    if "username" in update_data:
        new_username = update_data["username"]
        # A null username would clear a NOT NULL column. Omitting the key is how you leave it
        # alone; sending null is a mistake, not an instruction.
        if new_username is None:
            raise AppException(400, "INVALID_USERNAME", "Username cannot be cleared; omit the field instead.")

        if await is_username_taken(db, new_username, user.id):
            raise AppException(400, "USERNAME_TAKEN", "Username is already taken.")

    if update_data.get("full_name", "") is None:
        raise AppException(400, "INVALID_NAME", "Display name cannot be cleared; omit the field instead.")

    for key, value in update_data.items():
        setattr(user, key, value)

    await db.commit()
    await db.refresh(user)

    return SuccessResponse(data=user)


@router.get("/is-username-available/{username}", response_model=SuccessResponse[bool])
async def is_username_available(
        current_user: User = Depends(get_current_user),
        username: str = Path(..., description="Username"),
        db: AsyncSession = Depends(get_db)
):
    res = await is_username_taken(db, username, current_user.id)
    return SuccessResponse(data=not res)
