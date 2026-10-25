import re
import uuid

import phonenumbers
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.domains.crypto.schemas.crypto_schemas import RewrappedIdentity


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    full_name: str = Field(..., min_length=1, max_length=30)
    username: str = Field(..., min_length=6, max_length=50)
    password: str = Field(..., min_length=8, max_length=72)
    email: EmailStr
    phone_number: str
    public_key: str
    encrypted_private_key: str

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str):
        if not re.fullmatch(r"^[a-zA-Z][a-zA-Z0-9_]*$", v):
            raise ValueError(
                "Username must start with a letter and contain only letters, numbers, and underscore (_)"
            )
        # Deleted accounts are tombstoned under `deleted-<id>` and shown as "deleted"; keeping the
        # whole prefix unregistrable stops anyone from posing as one.
        if v.lower().startswith("deleted"):
            raise ValueError("Usernames starting with 'deleted' are reserved.")
        return v

    @field_validator("phone_number")
    @classmethod
    def validate_phone(cls, v: str):
        try:
            parsed_number = phonenumbers.parse(v)

            if not phonenumbers.is_valid_number(parsed_number):
                raise ValueError("Invalid phone number for this country.")

            return phonenumbers.format_number(
                parsed_number, phonenumbers.PhoneNumberFormat.E164
            )

        except phonenumbers.NumberParseException:
            raise ValueError("Invalid phone number format.")


class UserLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    password: str


class UserResponse(BaseModel):
    id: uuid.UUID
    full_name: str
    username: str
    email: EmailStr
    phone_number: str
    public_key: str
    bio: str | None = None
    # The model field is `avatar_url`; this was declared as `avatar`, which matches nothing, so
    # the owner's own avatar always serialised as null.
    avatar_url: str | None = None
    is_active: bool
    is_deleted: bool = False

    model_config = ConfigDict(from_attributes=True)


# What every public projection shows for a tombstoned account. The stored placeholders are unique
# values that exist only to keep the UNIQUE columns valid; none of them is ever sent to a client.
DELETED_USER_FULL_NAME = "Deleted user"
DELETED_USER_USERNAME = "deleted"


class UserSearchResponse(BaseModel):
    """Public projection of a user. A deleted account collapses to a neutral one.

    `is_deleted` is the flag clients key their "Deleted user" rendering on; the other fields carry
    no trace of the former owner.
    """

    id: uuid.UUID
    full_name: str
    username: str
    avatar_url: str | None = None
    bio: str | None = None
    is_deleted: bool = False

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="before")
    @classmethod
    def _mask_deleted(cls, data):
        if getattr(data, "deleted_at", None) is not None:
            return {
                "id": data.id,
                "full_name": DELETED_USER_FULL_NAME,
                "username": DELETED_USER_USERNAME,
                "avatar_url": None,
                "bio": None,
                "is_deleted": True,
            }
        return data


class UserBatchRequest(BaseModel):
    """Resolve ids to display names. Bounded like the crypto keys batch it mirrors."""
    model_config = ConfigDict(extra="forbid")

    user_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=512)


class PasswordForgot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    email: EmailStr


class PasswordReset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    otp: str = Field(..., min_length=6, max_length=6)

    new_password: str = Field(..., min_length=8, max_length=72)
    new_public_key: str
    new_encrypted_private_key: str


class PasswordChange(BaseModel):
    """Change password while KEEPING the identity keypair.

    The client re-derives its wrapping key from the new password and re-wraps the same private
    bundle. Nothing about the identity changes, so history stays readable. Contrast PasswordReset,
    where the bundle is unrecoverable and the identity necessarily dies with it.
    """
    model_config = ConfigDict(extra="forbid")

    old_password: str
    new_password: str = Field(..., min_length=8, max_length=72)

    # Legacy RSA bundle. Optional during the transition to X25519/Ed25519.
    new_encrypted_private_key: str | None = None
    # New-world equivalent: same keypair, re-wrapped under the new password.
    rewrapped_identities: list[RewrappedIdentity] | None = None


class AccountDeleteRequest(BaseModel):
    """Re-entering the password is mandatory: a stolen session must not be enough to destroy an account."""
    model_config = ConfigDict(extra="forbid")

    password: str = Field(..., min_length=1, max_length=72)


class EmailVerification(BaseModel):
    model_config = ConfigDict(extra="forbid")

    otp: str = Field(..., min_length=6, max_length=6)
    email: EmailStr
