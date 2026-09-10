import time
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Response

from app.core.config import settings


def verify_password(plain_password: str, hashed_password: str) -> bool:
    password_bytes = plain_password.encode("utf-8")
    hash_bytes = hashed_password.encode("utf-8")
    return bcrypt.checkpw(password_bytes, hash_bytes)


def get_password_hash(password: str) -> str:
    password_bytes = password.encode("utf-8")
    salt = bcrypt.gensalt()
    hashed_bytes = bcrypt.hashpw(password_bytes, salt)
    return hashed_bytes.decode("utf-8")


def issued_now() -> float:
    """The `iat` to stamp on a token, as a fractional epoch second.

    Whole seconds were not precise enough to be a revocation boundary. `force_logout` refuses any
    token issued before a cutoff, and both the cutoff and the token's `iat` were `int(time())` —
    so a refresh token minted in the *same second* as a password change compared equal to the
    cutoff and survived it. That is not a theoretical window: logging in and immediately changing
    your password lands in one second comfortably.

    Widening the comparison to `<=` cannot fix it either, because the replacement tokens the
    password change hands back are issued in that same second and would be refused too. Nudging
    them forward instead makes them fail PyJWT's `iat` check, which rejects a token dated in the
    future.

    RFC 7519 NumericDate explicitly permits a non-integer value, so sub-second precision is the
    fix: two sequential calls never collide, and nothing is ever stamped ahead of the clock.
    """
    return time.time()


def revocation_cutoff() -> float:
    """The `force_logout` value to write when ending every session for a user.

    Must be read *before* minting any replacement tokens, so that those tokens' `iat` is strictly
    greater and they survive the revocation they themselves triggered.
    """
    return time.time()


def create_access_token(
    data: dict, expires_delta: timedelta | None = None, issued_at: float | None = None
) -> str:
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=30)

    to_encode.update(
        {"exp": expire, "iat": issued_at if issued_at is not None else issued_now()}
    )

    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(
    data: dict, expires_delta: timedelta | None = None, issued_at: float | None = None
) -> str:
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=7)

    to_encode.update(
        {
            "exp": expire,
            "refresh": True,
            "iat": issued_at if issued_at is not None else issued_now(),
        }
    )

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
    response.delete_cookie(
        key="access_token", httponly=True, samesite="lax", secure=settings.COOKIE_SECURE
    )
    response.delete_cookie(
        key="refresh_token",
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
    )
