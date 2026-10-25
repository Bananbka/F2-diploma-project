import uuid

import jwt
from fastapi import Depends, Request, WebSocketException
from fastapi.security import OAuth2PasswordBearer
from redis import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status
from starlette.websockets import WebSocket

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.security import is_token_revoked
from app.domains.users.models.user import User
from app.domains.users.services.user_service import get_user_by_id
from app.infrastructure.postgres import AsyncSessionLocal, get_db
from app.infrastructure.redis import get_redis

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


async def get_current_unverified_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> User:
    token = request.cookies.get("access_token")

    if not token:
        raise AppException(401, "UNAUTHORIZED", "You are not logged in.")

    if await is_token_revoked(redis, token):
        raise AppException(
            status.HTTP_401_UNAUTHORIZED,
            "TOKEN_REVOKED",
            "Token blacklisted. Please log in again.",
        )

    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id: str = payload.get("sub")
        if user_id is None or payload.get("refresh"):
            raise AppException(401, "INVALID_TOKEN", "Invalid token data.")
    except jwt.ExpiredSignatureError:
        raise AppException(401, "TOKEN_EXPIRED", "Token is expired.")
    except jwt.PyJWTError:
        raise AppException(401, "INVALID_TOKEN", "Invalid token.")

    # A malformed `sub` used to raise ValueError straight out of here and render as a 500. A
    # token we cannot parse is an invalid token, which is a 401.
    try:
        subject = uuid.UUID(user_id)
    except (TypeError, ValueError):
        raise AppException(401, "INVALID_TOKEN", "Invalid token data.")

    user = await get_user_by_id(db, subject)
    if user is None:
        raise AppException(401, "INVALID_TOKEN", "Invalid token.")

    # `is_active` existed on the model and was read nowhere, so disabling an account did nothing:
    # existing sessions kept working and the holder could sign in again.
    if not user.is_active:
        raise AppException(403, "ACCOUNT_DISABLED", "This account has been disabled.")

    iat = payload.get("iat")
    if iat:
        logout_timestamp = await redis.get(f"force_logout:{user.id}")

        # Fractional seconds on both sides, compared strictly. Whole seconds could not separate
        # a token minted in the same second as the cutoff from one minted before it, so a
        # refresh token issued moments before a password change used to survive it.
        if logout_timestamp and float(iat) < float(logout_timestamp):
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


async def check_ws_origin(websocket: WebSocket) -> None:
    """Refuse a handshake whose Origin is absent or not allow-listed, before accept().

    Auth is cookie-based, so without this any page the user visits could open an authenticated
    socket in their browser. Non-browser clients must send an allowed Origin explicitly.
    """
    origin = websocket.headers.get("origin")
    if not origin or origin not in settings.ALLOWED_ORIGINS:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)


async def ws_session_is_valid(redis, token: str) -> bool:
    """Re-run the handshake checks for a socket that is already open.

    The handshake validates the session once; without this an open socket would outlive logout,
    a password change, account disabling and the token's own expiry. A fresh DB session is used
    because the socket's request-scoped one is busy in the receive loop.
    """
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = uuid.UUID(payload.get("sub"))
    except (jwt.PyJWTError, TypeError, ValueError):
        return False

    if payload.get("refresh") or await is_token_revoked(redis, token):
        return False

    iat = payload.get("iat")
    if iat:
        logout_timestamp = await redis.get(f"force_logout:{user_id}")
        if logout_timestamp and float(iat) < float(logout_timestamp):
            return False

    async with AsyncSessionLocal() as session:
        row = (
            await session.execute(
                select(User.is_active, User.is_verified).where(User.id == user_id)
            )
        ).one_or_none()

    return row is not None and bool(row.is_active) and bool(row.is_verified)


async def get_ws_current_user(
    websocket: WebSocket,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> User:
    token = websocket.cookies.get("access_token")

    if not token:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    if await is_token_revoked(redis, token):
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
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

    if not user.is_verified or not user.is_active:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    iat = payload.get("iat")
    if iat:
        logout_timestamp = await redis.get(f"force_logout:{user.id}")

        # Fractional seconds on both sides, compared strictly. Whole seconds could not separate
        # a token minted in the same second as the cutoff from one minted before it, so a
        # refresh token issued moments before a password change used to survive it.
        if logout_timestamp and float(iat) < float(logout_timestamp):
            raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)

    return user
