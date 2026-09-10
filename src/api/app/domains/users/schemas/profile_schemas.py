import re

from pydantic import BaseModel, Field, field_validator


class ProfileRequestSchema(BaseModel):
    """Partial profile update.

    Every field is optional, including `full_name` — it was required on a PATCH, so a client
    changing only a bio had to resend the name it was not touching, and forgetting to would blank
    nothing but fail validation instead.
    """
    full_name: str | None = Field(None, min_length=1, max_length=30)
    username: str | None = Field(None, min_length=6, max_length=50)
    # Bounded because the columns are unbounded `Text`: without a limit one PATCH can store as
    # much as the request body allows.
    bio: str | None = Field(None, max_length=500)
    avatar_url: str | None = Field(None, max_length=1024)

    @field_validator('username')
    @classmethod
    def validate_username(cls, v: str | None):
        # An explicit `"username": null` used to reach `re.fullmatch(pattern, None)` and raise a
        # TypeError, which surfaced as a 500 rather than a validation error.
        if v is None:
            return v

        if not re.fullmatch(r'^[a-zA-Z][a-zA-Z0-9_]*$', v):
            raise ValueError(
                'Username must start with a letter and contain only letters, numbers, and underscore (_)'
            )
        return v
