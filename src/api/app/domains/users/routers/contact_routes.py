import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.core.responses import SuccessResponse
from app.domains.users.dependencies import get_current_user
from app.domains.users.models import User
from app.domains.users.schemas.contact_schemas import (
    ContactCreateRequest,
    ContactResponse,
)
from app.domains.users.services import contact_service
from app.infrastructure.postgres import get_db

router = APIRouter(prefix="/contact", tags=["Contacts"])


@router.post("/", response_model=SuccessResponse[ContactResponse])
async def create_contact(
    data: ContactCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    contact = await contact_service.add_user_to_contacts(
        db, user.id, data.target_user_id, data.alias
    )
    await db.refresh(contact, ["user"])
    return SuccessResponse(data=contact)


@router.get("/", response_model=SuccessResponse[list[ContactResponse]])
async def get_contacts(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    contact = await contact_service.get_user_contacts(db, user.id)
    return SuccessResponse(data=contact)


@router.delete("/{contact_id}", response_model=SuccessResponse[dict])
async def delete_contact(
    contact_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove someone from your contacts.

    There was no way to undo `POST /contact/`: a contact, once added, was permanent, and the alias
    it carries overrides the displayed name in every private chat with that person.
    """
    removed = await contact_service.remove_contact(db, user.id, contact_id)
    if not removed:
        raise AppException(404, "NOT_FOUND", "That user is not in your contacts.")

    return SuccessResponse(data={"message": "Contact removed."})
