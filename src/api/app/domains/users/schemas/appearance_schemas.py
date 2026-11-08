"""Per-user chat appearance, stored as one JSONB document on `users.chat_appearance`.

Every value is an enum, a bounded integer or a strict hex colour, so the stored document is
bounded by the schema and carries no free-form text.
"""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

HEX_COLOR = r"^#[0-9a-fA-F]{6}$"

type FontFamily = Literal["inter", "system", "serif", "mono", "rounded"]
type GradientName = Literal["aurora", "dusk", "ocean", "forest", "sunset"]


class Background(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["default", "color", "gradient"] = "default"
    color: str | None = Field(default=None, pattern=HEX_COLOR)
    gradient: GradientName | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
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
    own_bubble_color: str | None = Field(default=None, pattern=HEX_COLOR)
    other_bubble_color: str | None = Field(default=None, pattern=HEX_COLOR)
    background: Background = Field(default_factory=Background)
    version: Literal[1] = 1


class AppearanceResponse(Appearance):
    """Same shape as the request; always a complete document."""
