import time
from datetime import timedelta, timezone, datetime

import jwt
import bcrypt
from fastapi import Response

from app.core.config import settings


def verify_password(plain_password: str, hashed_password: str) -> bool:
    password_bytes = plain_password.encode('utf-8')
    hash_bytes = hashed_password.encode('utf-8')
    return bcrypt.checkpw(password_bytes, hash_bytes)


def get_password_hash(password: str) -> str:
    password_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()
    hashed_bytes = bcrypt.hashpw(password_bytes, salt)
    return hashed_bytes.decode('utf-8')


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=30)

    to_encode.update({"exp": expire, "iat": int(time.time())})

    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=7)

    to_encode.update({"exp": expire, "refresh": True, "iat": int(time.time())})

    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def set_token_cookie(response: Response, token: str, token_type: str) -> None:
    match token_type:
        case "refresh":
            response.set_cookie(
                key="refresh_token",
                value=token,
                httponly=True,
                max_age=604800,
                samesite="lax",
                secure=settings.COOKIE_SECURE,
            )
        case "access":
            response.set_cookie(
                key="access_token",
                value=token,
                httponly=True,
                max_age=1800,
                samesite="lax",
                secure=settings.COOKIE_SECURE,
            )
        case _:
            raise ValueError("Invalid token type")


def delete_token_cookies(response: Response) -> None:
    response.delete_cookie(key="access_token", httponly=True, samesite="lax", secure=settings.COOKIE_SECURE)
    response.delete_cookie(key="refresh_token", httponly=True, samesite="lax", secure=settings.COOKIE_SECURE)
