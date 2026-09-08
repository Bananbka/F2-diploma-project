from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.responses import SuccessResponse
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.domains.users.schemas.contact_schemas import ContactResponse, ContactCreateRequest
from app.domains.users.services import contact_service
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/contact", tags=["Contacts"])


@router.post("/", response_model=SuccessResponse[ContactResponse])
async def create_contact(
        data: ContactCreateRequest,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    contact = await contact_service.add_user_to_contacts(db, user.id, data.target_user_id, data.alias)
    await db.refresh(contact, ['user'])
    return SuccessResponse(data=contact)


@router.get("/", response_model=SuccessResponse[list[ContactResponse]])
async def get_contacts(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
):
    contact = await contact_service.get_user_contacts(db, user.id)
    return SuccessResponse(data=contact)
