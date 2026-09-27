import time
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from contextlib import asynccontextmanager
from loguru import logger

from app.core.logger import setup_logging
from app.core.exceptions import (
    AppException,
    app_exception_handler,
    validation_exception_handler,
    global_exception_handler
)
from app.domains.users.routers.auth_routes import router as auth_router
from app.domains.users.routers.profile_routes import router as profile_router
from app.domains.users.routers.user_routes import router as user_router
from app.domains.users.routers.contact_routes import router as contact_router
from app.domains.chats.routers.chat_routes import router as chats_router
from app.domains.chats.routers.folder_routes import router as folder_router
from app.domains.chats.routers.invite_link_routes import (
    chat_scoped_router as invite_link_chat_router,
    router as invite_link_router,
)
from app.domains.crypto.routers.crypto_routes import router as crypto_router
from app.domains.files.routers.file_routes import router as file_router
from app.domains.messages.routes.messages_routes import router as messages_router
from app.domains.messages.routes.ws_router import ws_router

from app.infrastructure.minio import minio_manager
from app.infrastructure.mongo import connect_to_mongo, close_mongo_connection
from app.infrastructure.redis import init_redis

setup_logging(is_production=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Mess&Gags API...")
    await connect_to_mongo()
    await init_redis()
    await minio_manager.ensure_bucket_exists()
    yield
    logger.info("Stopping Mess&Gags API...")
    await close_mongo_connection()


app = FastAPI(title="Mess&Gags API", lifespan=lifespan)

app.add_exception_handler(AppException, app_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, global_exception_handler)


def _loggable_path(path: str) -> str:
    """Redact the token segment of `/invite-links/{token}` (the preview endpoint) before it
    reaches any log line.

    Join and revoke already keep their tokens out of the URL entirely (see
    `invite_link_routes.py`), but preview is meant to be a clickable, shareable link, so the
    token has to stay in its path — the credential-disclosure risk there is suppressing the log,
    not restructuring the route. `security_audit`'s own `INVITE_LINK_*` events never take this
    path; this only affects the plain request-timing log below.
    """
    prefix = "/invite-links/"
    if path.startswith(prefix):
        rest = path[len(prefix):]
        token, _, tail = rest.partition("/")
        if token:
            return f"{prefix}<redacted>{('/' + tail) if tail else ''}"
    return path


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    path = _loggable_path(request.url.path)

    logger.info(f"Incoming request: {request.method} {path}")

    response = await call_next(request)

    process_time = time.time() - start_time
    logger.info(
        f"Completed request: {request.method} {path} - Status: {response.status_code} - Time: {process_time:.4f}s")

    return response


app.include_router(auth_router)
app.include_router(profile_router)
app.include_router(user_router)
app.include_router(contact_router)
app.include_router(chats_router)
app.include_router(invite_link_chat_router)
app.include_router(invite_link_router)
app.include_router(folder_router)
app.include_router(messages_router)
app.include_router(ws_router)
app.include_router(file_router)
app.include_router(crypto_router)
