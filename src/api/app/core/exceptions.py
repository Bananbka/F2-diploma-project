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
            details: any = None
    ):
        self.status_code = status_code
        self.error_code = error_code
        self.message = message
        self.details = details


async def app_exception_handler(request: Request, exc: AppException):
    logger.warning(f"App error: {exc.error_code} - {exc.message}")
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            error_code=exc.error_code,
            message=exc.message,
            details=exc.details
        ).model_dump()
    )


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.warning(f"Validation error: {exc.errors()}")
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=ErrorResponse(
            error_code="VALIDATION_ERROR",
            message="Data validation error.",
            details=jsonable_encoder(exc.errors())
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
