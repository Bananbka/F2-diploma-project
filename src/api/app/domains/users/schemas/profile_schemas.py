import re

from pydantic import BaseModel, field_validator


class ProfileRequestSchema(BaseModel):
    full_name: str
    username: str | None = None
    bio: str | None = None
    avatar_url: str | None = None

    @field_validator('username')
    @classmethod
    def validate_username(cls, v: str):
        if not re.fullmatch(r'^[a-zA-Z][a-zA-Z0-9_]*$', v):
            raise ValueError(
                'Username must start with a letter and contain only letters, numbers, and underscore (_)'
            )
        return v
