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


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()

    logger.info(f"Incoming request: {request.method} {request.url.path}")

    response = await call_next(request)

    process_time = time.time() - start_time
    logger.info(
        f"Completed request: {request.method} {request.url.path} - Status: {response.status_code} - Time: {process_time:.4f}s")

    return response


app.include_router(auth_router)
app.include_router(profile_router)
app.include_router(user_router)
app.include_router(contact_router)
app.include_router(chats_router)
app.include_router(folder_router)
app.include_router(messages_router)
app.include_router(ws_router)
app.include_router(file_router)
app.include_router(crypto_router)
