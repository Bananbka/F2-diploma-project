import uuid

import jwt
from fastapi import Depends, Request, WebSocketException
from fastapi.security import OAuth2PasswordBearer
from redis import Redis
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status
from starlette.websockets import WebSocket

from app.core.config import settings
from app.core.exceptions import AppException
from app.domains.users.models.user import User
from app.domains.users.services.user_service import get_user_by_id
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


async def get_current_unverified_user(
        request: Request,
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis)
) -> User:
    token = request.cookies.get("access_token")

    if not token:
        raise AppException(401, "UNAUTHORIZED", "You are not logged in.")

    is_blacklisted = await redis.get(f"blacklist:{token}")
    if is_blacklisted:
        raise AppException(
            status.HTTP_401_UNAUTHORIZED, "TOKEN_REVOKED", "Token blacklisted. Please log in again.",
        )

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None or payload.get("refresh"):
            raise AppException(401, "INVALID_TOKEN", "Invalid token data.")
    except jwt.ExpiredSignatureError:
        raise AppException(401, "TOKEN_EXPIRED", "Token is expired.")
    except jwt.PyJWTError:
        raise AppException(401, "INVALID_TOKEN", "Invalid token.")

    user = await get_user_by_id(db, uuid.UUID(user_id))
    if user is None:
        raise AppException(404, "USER_NOT_FOUNR", "User is not found.")

    iat = payload.get("iat")
    if iat:
        logout_timestamp = await redis.get(f"force_logout:{user.id}")

        if logout_timestamp and iat < int(logout_timestamp):
            raise AppException(
                status.HTTP_401_UNAUTHORIZED,
                "SESSION_EXPIRED",
                "Your session was terminated. Please log in again.",
            )

    return user


async def get_current_user(
        current_unverified_user: User = Depends(get_current_unverified_user),
) -> User:
    if not current_unverified_user.is_verified:
        raise AppException(403, "NOT_VERIFIED", "You are not verified.")
    return current_unverified_user


async def get_ws_current_user(
        websocket: WebSocket,
        db: AsyncSession = Depends(get_db),
        redis: Redis = Depends(get_redis)
) -> User:
    token = websocket.cookies.get("access_token")

    if not token:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    is_blacklisted = await redis.get(f"blacklist:{token}")
    if is_blacklisted:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None or payload.get("refresh"):
            raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)
    except jwt.PyJWTError:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    try:
        user = await get_user_by_id(db, uuid.UUID(user_id))
    except ValueError:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    if user is None:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    if not user.is_verified:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    iat = payload.get("iat")
    if iat:
        logout_timestamp = await redis.get(f"force_logout:{user.id}")

        if logout_timestamp and iat < int(logout_timestamp):
            raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    return user
