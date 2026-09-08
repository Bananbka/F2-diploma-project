import re
import uuid

import phonenumbers
from pydantic import BaseModel, Field, ConfigDict, EmailStr, field_validator

from app.domains.crypto.schemas.crypto_schemas import RewrappedIdentity


class UserCreate(BaseModel):
    full_name: str = Field(..., min_length=1, max_length=30)
    username: str = Field(..., min_length=6, max_length=50)
    password: str = Field(..., min_length=8, max_length=72)
    email: EmailStr
    phone_number: str
    public_key: str
    encrypted_private_key: str

    @field_validator('username')
    @classmethod
    def validate_username(cls, v: str):
        if not re.fullmatch(r'^[a-zA-Z][a-zA-Z0-9_]*$', v):
            raise ValueError(
                'Username must start with a letter and contain only letters, numbers, and underscore (_)'
            )
        return v

    @field_validator('phone_number')
    @classmethod
    def validate_phone(cls, v: str):
        try:
            parsed_number = phonenumbers.parse(v)

            if not phonenumbers.is_valid_number(parsed_number):
                raise ValueError('Invalid phone number for this country.')

            return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)

        except phonenumbers.NumberParseException:
            raise ValueError('Invalid phone number format.')


class UserLogin(BaseModel):
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
    avatar: str | None = None
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class UserSearchResponse(BaseModel):
    id: uuid.UUID
    full_name: str
    username: str
    avatar_url: str | None = None
    bio: str | None = None

    class Config:
        from_attributes = True


class UserBatchRequest(BaseModel):
    """Resolve ids to display names. Bounded like the crypto keys batch it mirrors."""
    user_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=512)


class PasswordForgot(BaseModel):
    username: str
    email: EmailStr


class PasswordReset(BaseModel):
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
    old_password: str
    new_password: str = Field(..., min_length=8, max_length=72)

    # Legacy RSA bundle. Optional during the transition to X25519/Ed25519.
    new_encrypted_private_key: str | None = None
    # New-world equivalent: same keypair, re-wrapped under the new password.
    rewrapped_identities: list[RewrappedIdentity] | None = None


class EmailVerification(BaseModel):
    otp: str = Field(..., min_length=6, max_length=6)
    email: EmailStr
