"""Per-user chat appearance, stored as one JSONB document on `users.chat_appearance`.

Every value is an enum, a bounded integer or a strict hex colour, so the stored document is
bounded by the schema and carries no free-form text.
"""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

HEX_COLOR = r"^#[0-9a-fA-F]{6}$"

type FontFamily = Literal["inter", "system", "serif", "mono", "rounded"]
type GradientName = Literal["aurora", "dusk", "ocean", "forest", "sunset"]


VERSION_PATTERN = r"^[0-9a-f]{8,64}$"


class BackgroundImage(BaseModel):
    """Tuning of the user's uploaded background. `version` is server-owned: whatever a client sends
    is replaced by the hash stored at upload time, so it can neither be forged nor point elsewhere."""

    model_config = ConfigDict(extra="forbid")

    fit: Literal["cover", "contain", "tile"] = "cover"
    position_x: int = Field(default=50, ge=0, le=100, strict=True)
    position_y: int = Field(default=50, ge=0, le=100, strict=True)
    zoom: int = Field(default=100, ge=100, le=300, strict=True)
    dim: int = Field(default=0, ge=0, le=80, strict=True)
    blur: int = Field(default=0, ge=0, le=20, strict=True)
    version: str | None = Field(default=None, pattern=VERSION_PATTERN)


class Background(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["default", "color", "gradient", "image"] = "default"
    color: str | None = Field(default=None, pattern=HEX_COLOR)
    gradient: GradientName | None = None
    image: BackgroundImage | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.kind == "image":
            if self.image is None or self.color is not None or self.gradient is not None:
                raise ValueError("background kind 'image' requires image and no color or gradient")
            return self
        if self.image is not None:
            raise ValueError("background image is only allowed with kind 'image'")
        if self.kind == "color":
            if self.color is None or self.gradient is not None:
                raise ValueError("background kind 'color' requires color and no gradient")
        elif self.kind == "gradient":
            if self.gradient is None or self.color is not None:
                raise ValueError("background kind 'gradient' requires gradient and no color")
        elif self.color is not None or self.gradient is not None:
            raise ValueError("background kind 'default' must not set color or gradient")
        return self


class Appearance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    font_size: int = Field(default=15, ge=12, le=22, strict=True)
    font_family: FontFamily = "inter"
    bubble_radius: int = Field(default=19, ge=0, le=28, strict=True)
    own_bubble_color: str | None = Field(default=None, pattern=HEX_COLOR)
    other_bubble_color: str | None = Field(default=None, pattern=HEX_COLOR)
    background: Background = Field(default_factory=Background)
    # Read-only: content hash of the uploaded background object, None when nothing is uploaded.
    # Accepted on input so a response can be sent back unchanged, but always overwritten.
    background_image_version: str | None = Field(default=None, pattern=VERSION_PATTERN)
    version: Literal[1] = 1


class AppearanceResponse(Appearance):
    """Same shape as the request; always a complete document."""
