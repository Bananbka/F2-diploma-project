from typing import Generic, TypeVar, Any
from pydantic import BaseModel

T = TypeVar("T")


class SuccessResponse(BaseModel, Generic[T]):
    status: str = "success"
    data: T
    meta: dict[str, Any] | None = None


class ErrorResponse(BaseModel):
    status: str = "error"
    error_code: str
    message: str
    details: Any | None = None
