from fastapi import Request, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from app.core.responses import ErrorResponse
from loguru import logger


class AppException(Exception):
    def __init__(
            self,
            status_code: int,
            error_code: str,
            message: str,
            details: any = None,
            headers: dict[str, str] | None = None
    ):
        self.status_code = status_code
        self.error_code = error_code
        self.message = message
        self.details = details
        self.headers = headers


async def app_exception_handler(request: Request, exc: AppException):
    logger.warning(f"App error: {exc.error_code} - {exc.message}")
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            error_code=exc.error_code,
            message=exc.message,
            details=exc.details
        ).model_dump(),
        headers=exc.headers,
    )


# The only keys of a Pydantic error that are safe to log or return. Everything else can echo the
# request: `input` is the offending value — for a `missing` field it is the *whole* enclosing body,
# so a login without a username logged and returned the password, and a malformed reset request
# the OTP and the new password. `ctx` can carry the original exception or the rejected value, and
# `url` is just noise. An allowlist rather than a denylist, so a key a future Pydantic adds is
# dropped by default instead of leaking by default.
_SAFE_ERROR_KEYS = ("loc", "msg", "type")


def sanitize_validation_errors(errors) -> list[dict]:
    """Reduce Pydantic/FastAPI validation errors to `loc`, `msg` and `type` only."""
    return [
        {key: jsonable_encoder(error[key]) for key in _SAFE_ERROR_KEYS if key in error}
        for error in errors
    ]


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = sanitize_validation_errors(exc.errors())
    logger.warning(f"Validation error: {errors}")
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=ErrorResponse(
            error_code="VALIDATION_ERROR",
            message="Data validation error.",
            details=errors,
        ).model_dump()
    )


async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=ErrorResponse(
            error_code="INTERNAL_SERVER_ERROR",
            message="Internal server error: we already working on it."
        ).model_dump()
    )
