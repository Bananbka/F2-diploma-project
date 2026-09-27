import time
import uuid

import jwt
from fastapi import APIRouter, Depends, Request, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.audit import AuditEvent
from app.core.config import settings
from app.core.exceptions import AppException
from app.core.rate_limit import client_identifier, enforce_rate_limit, reset_rate_limit
from app.core.responses import SuccessResponse
from app.core.security import (
    create_access_token,
    create_refresh_token,
    delete_token_cookies,
    get_password_hash,
    revocation_cutoff,
    set_token_cookie,
    verify_password,
)
from app.domains.crypto.models import EpochReason
from app.domains.crypto.services import epoch_service, identity_service
from app.domains.users.dependencies import get_current_unverified_user, get_current_user
from app.domains.users.models.user import User
from app.domains.users.schemas.user_schemas import (
    EmailVerification,
    PasswordChange,
    PasswordForgot,
    PasswordReset,
    UserCreate,
    UserLogin,
    UserResponse,
)
from app.domains.users.services import user_service
from app.domains.users.services.auth_service import check_otp, generate_otp
from app.domains.users.services.user_service import (
    get_user_by_email,
    get_user_by_email_and_username,
    get_user_by_username,
)
from app.domains.users.tasks import EmailTasks, send_email
from app.infrastructure.mongo import get_mongo_db
from app.infrastructure.postgres import get_db
from app.infrastructure.redis import get_redis

router = APIRouter(prefix="/auth", tags=["Authentication"])

# Every unauthenticated entry point is limited twice: once on the caller's address, to slow a
# single attacker down, and once on the account being targeted, so that spreading the attempts
# across addresses does not make an account any easier to break into.
LOGIN_WINDOW = 300
LOGIN_PER_IP = 20
LOGIN_PER_ACCOUNT = 8

OTP_REQUEST_WINDOW = 900
OTP_REQUEST_PER_ACCOUNT = 3

VERIFY_WINDOW = 900
VERIFY_PER_IP = 20

REGISTER_WINDOW = 3600
REGISTER_PER_IP = 5

# `change-password` checks `old_password` against an authenticated session, so it has no IP-scoped
# limit to pair with the account-scoped one — an attacker with a stolen session cookie has no other
# address to spread guesses across. Same window/count as the account-scoped login limit.
CHANGE_PASSWORD_WINDOW = 300
CHANGE_PASSWORD_PER_ACCOUNT = 8


### AUTHENTICATION
@router.post("/register", response_model=SuccessResponse[UserResponse])
async def register(
    user_in: UserCreate,
    response: Response,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    await enforce_rate_limit(
        redis,
        scope="register",
        identifier=client_identifier(request),
        limit=REGISTER_PER_IP,
        window_seconds=REGISTER_WINDOW,
        message="Too many accounts created from here. Please try again later.",
    )

    existing_user = await get_user_by_email(db, email=user_in.email)
    if existing_user:
        raise AppException(409, "INVALID_EMAIL", "Email already exists.")

    # `phone_number` is unique in the database but nothing checked it, so a duplicate surfaced as
    # an IntegrityError and a 500 rather than a field error the form could show.
    if await user_service.get_user_by_phone(db, user_in.phone_number):
        raise AppException(409, "INVALID_PHONE", "Phone number already registered.")

    user = await user_service.create_user(db, user_in)

    otp = await generate_otp(redis, "email-verification", user_in.email)
    send_email.delay(EmailTasks.EMAIL_VERIFICATION.value, user_in.email, otp=otp)

    access_token = create_access_token(data={"sub": str(user.id)})
    refresh_token = create_refresh_token(data={"sub": str(user.id)})

    set_token_cookie(response, access_token, "access")
    set_token_cookie(response, refresh_token, "refresh")

    return SuccessResponse(data=user, meta={"message": "Email was sent"})


@router.post("/verify-email", response_model=SuccessResponse[UserResponse])
async def verify_email(
    data: EmailVerification,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    await enforce_rate_limit(
        redis,
        scope="verify-email",
        identifier=client_identifier(request),
        limit=VERIFY_PER_IP,
        window_seconds=VERIFY_WINDOW,
    )

    is_valid = await check_otp(redis, "email-verification", data.email, data.otp)
    if not is_valid:
        raise AppException(400, "INVALID_OTP", "Invalid or expired code.")

    user = await get_user_by_email(db, email=data.email)
    if not user:
        raise AppException(404, "USER_DOESNT_EXIST", "User does not exist.")

    user.is_verified = True
    await db.commit()

    return SuccessResponse(data=user)


@router.post("/get-verification-email", response_model=SuccessResponse[dict])
async def get_verification_email(
    user: User = Depends(get_current_unverified_user), redis: Redis = Depends(get_redis)
):
    if user.is_verified:
        raise AppException(400, "ALREADY_VERIFIED", "User is already verified.")

    # Also an outbound-email limit: without it this endpoint is a free mail cannon aimed at any
    # address, which gets the sending domain blacklisted.
    await enforce_rate_limit(
        redis,
        scope="otp-request",
        identifier=str(user.id),
        limit=OTP_REQUEST_PER_ACCOUNT,
        window_seconds=OTP_REQUEST_WINDOW,
        message="A code was just sent. Please wait before requesting another.",
    )

    otp = await generate_otp(redis, "email-verification", user.email)
    send_email.delay(EmailTasks.EMAIL_VERIFICATION.value, user.email, otp=otp)

    return SuccessResponse(data={"message": "Mail was successfully sent."})


@router.post("/login", response_model=SuccessResponse[UserResponse])
async def login(
    user_in: UserLogin,
    response: Response,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    caller = client_identifier(request)

    await enforce_rate_limit(
        redis,
        scope="login-ip",
        identifier=caller,
        limit=LOGIN_PER_IP,
        window_seconds=LOGIN_WINDOW,
    )
    await enforce_rate_limit(
        redis,
        scope="login-account",
        identifier=user_in.username.lower(),
        limit=LOGIN_PER_ACCOUNT,
        window_seconds=LOGIN_WINDOW,
        message="Too many failed sign-ins for this account. Please wait and try again.",
    )

    user = await user_service.get_user_by_username(db, user_in.username)

    if not user or not verify_password(user_in.password, user.hashed_password):
        # Recorded with the attempted username rather than a user id, since there may be no such
        # user — that is the difference between a typo and someone walking the directory.
        await audit.record(
            mongo_db,
            AuditEvent.LOGIN_FAILED,
            user_id=user.id if user else None,
            client_ip=caller,
            details={"username": user_in.username},
        )
        raise AppException(401, "INVALID_CREDENTIALS", "Incorrect username or password")

    # A disabled account could still sign in and use the API: `is_active` was written at
    # registration and then never read anywhere in the codebase.
    if not user.is_active:
        await audit.record(
            mongo_db,
            AuditEvent.LOGIN_FAILED,
            user_id=user.id,
            client_ip=caller,
            details={"reason": "account_disabled"},
        )
        raise AppException(403, "ACCOUNT_DISABLED", "This account has been disabled.")

    # Clear the counters on success so a user who mistyped twice is not locked out of their own
    # account for the rest of the window.
    await reset_rate_limit(
        redis, scope="login-ip", identifier=caller, window_seconds=LOGIN_WINDOW
    )
    await reset_rate_limit(
        redis,
        scope="login-account",
        identifier=user_in.username.lower(),
        window_seconds=LOGIN_WINDOW,
    )

    access_token = create_access_token(data={"sub": str(user.id)})
    refresh_token = create_refresh_token(data={"sub": str(user.id)})

    set_token_cookie(response, access_token, "access")
    set_token_cookie(response, refresh_token, "refresh")

    await audit.record(
        mongo_db, AuditEvent.LOGIN_SUCCEEDED, user_id=user.id, client_ip=caller
    )

    return SuccessResponse(data=user)


@router.post("/logout", response_model=SuccessResponse[dict])
async def logout(
    request: Request,
    response: Response,
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    # Both cookies are revoked. Blacklisting only the access token left the refresh token live,
    # so "log out" ended nothing a holder of that cookie could not immediately undo.
    #
    # Signatures are verified before anything is written. Decoding with verify_signature=False let
    # an unauthenticated caller push arbitrary forged tokens with far-future `exp` values into
    # Redis and hold the memory for as long as they liked.
    subject = None

    for cookie_name in ("access_token", "refresh_token"):
        token = request.cookies.get(cookie_name)
        if not token:
            continue

        try:
            payload = jwt.decode(
                token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
            )
        except jwt.PyJWTError:
            continue

        subject = subject or payload.get("sub")

        exp = payload.get("exp")
        if exp is None:
            continue

        ttl = int(exp - time.time())
        if ttl > 0:
            await redis.setex(f"blacklist:{token}", ttl, "revoked")

    delete_token_cookies(response)

    if subject:
        try:
            await audit.record(
                mongo_db,
                AuditEvent.LOGOUT,
                user_id=uuid.UUID(subject),
                client_ip=client_identifier(request),
            )
        except ValueError:
            pass

    return SuccessResponse(data={"message": "Token deactivated"})


@router.post("/refresh", response_model=SuccessResponse[dict])
async def refresh(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Mint a new access token from the refresh cookie.

    This endpoint used to check nothing but the signature, which quietly voided every revocation
    the system had. `force_logout` is compared against a token's `iat`, and the access token minted
    here carries a *fresh* `iat` — so a stolen refresh token sailed straight past logout, password
    change and password reset, all three of which exist precisely to end a compromised session.

    Every check `get_current_unverified_user` performs therefore has to happen here too.
    """
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise AppException(
            401, "NO_REFRESH_TOKEN", "There is no refresh token in cookies."
        )

    if await redis.get(f"blacklist:{refresh_token}"):
        raise AppException(401, "TOKEN_REVOKED", "Session ended. Please log in again.")

    try:
        payload = jwt.decode(
            refresh_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
    except jwt.PyJWTError:
        raise AppException(401, "INVALID_REFRESH", "Session error.")

    if not payload.get("refresh"):
        raise AppException(401, "INVALID_TOKEN", "Invalid token data.")

    subject = payload.get("sub")
    try:
        user_id = uuid.UUID(subject)
    except (TypeError, ValueError):
        raise AppException(401, "INVALID_TOKEN", "Invalid token data.")

    # The refresh token's own `iat` is what must clear the cutoff. Checking the new access token's
    # would be checking a value we just generated.
    issued_at = payload.get("iat")
    logout_timestamp = await redis.get(f"force_logout:{user_id}")
    if logout_timestamp and (
        issued_at is None or float(issued_at) < float(logout_timestamp)
    ):
        raise AppException(
            401, "SESSION_EXPIRED", "Your session was terminated. Please log in again."
        )

    user = await user_service.get_user_by_id(db, user_id)
    if user is None or not user.is_active:
        raise AppException(401, "INVALID_REFRESH", "Session error.")

    new_access = create_access_token(data={"sub": str(user.id)})
    set_token_cookie(response, new_access, "access")

    return SuccessResponse(data={"message": "Token has been successfully updated."})


### RESTORE
@router.post("/forgot-password", response_model=SuccessResponse[dict])
async def forgot_password(
    user_data: PasswordForgot,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Send a reset code, without revealing whether the account exists.

    The old 404 turned this endpoint into a free membership oracle: anyone could confirm which
    username/email pairs were registered. The response is now identical either way, and the work
    that differs (sending mail) is invisible to the caller.
    """
    await enforce_rate_limit(
        redis,
        scope="forgot-ip",
        identifier=client_identifier(request),
        limit=VERIFY_PER_IP,
        window_seconds=VERIFY_WINDOW,
    )
    await enforce_rate_limit(
        redis,
        scope="forgot-account",
        identifier=user_data.username.lower(),
        limit=OTP_REQUEST_PER_ACCOUNT,
        window_seconds=OTP_REQUEST_WINDOW,
        message="A reset code was recently sent. Please check your email before requesting another.",
    )

    user = await get_user_by_email_and_username(db, user_data.username, user_data.email)

    if user is not None:
        otp = await generate_otp(redis, "password_reset", user.id)
        send_email.delay(EmailTasks.PASSWORD_RESET.value, user.email, otp=otp)

    return SuccessResponse(
        data={
            "message": "If those details match an account, a reset code has been sent."
        }
    )


@router.post("/reset-password", response_model=SuccessResponse[dict])
async def reset_password(
    user_data: PasswordReset,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    await enforce_rate_limit(
        redis,
        scope="reset-ip",
        identifier=client_identifier(request),
        limit=VERIFY_PER_IP,
        window_seconds=VERIFY_WINDOW,
    )

    user = await get_user_by_username(db, user_data.username)

    # Same non-answer as forgot-password, for the same reason. The old 404 distinguished "no such
    # user" from "wrong code", so an attacker could enumerate accounts here as well.
    if not user:
        raise AppException(400, "INVALID_OTP", "Invalid or expired code.")

    is_valid = await check_otp(redis, "password_reset", user.id, user_data.otp)
    if not is_valid:
        raise AppException(400, "INVALID_OTP", "Invalid or expired code.")

    user.hashed_password = get_password_hash(user_data.new_password)
    user.public_key = user_data.new_public_key
    user.encrypted_private_key = user_data.new_encrypted_private_key

    # A forgotten password means the Argon2id-wrapped bundle is unrecoverable, so the identity
    # dies with it. Revoke every device rather than leaving keys that nobody can ever unwrap;
    # the client must publish a fresh identity after logging back in. All pre-reset history is
    # permanently unreadable — that is inherent to E2E, and the UI must say so plainly.
    await identity_service.deactivate_user_devices(db, user.id)

    # Revoking devices shrinks the member set of every encrypted chat this user is in, so those
    # chats must re-key in the same transaction. Without it the roster no longer matches the
    # epoch's stored commitment and every remaining member's client correctly refuses to send.
    await epoch_service.rotate_chats_for_member_change(
        db, user.id, EpochReason.MEMBER_REMOVED
    )

    await db.commit()

    # Every device is revoked, and no replacement session is issued here — the user must log in
    # again with the new password.
    await redis.setex(f"force_logout:{user.id}", 604800, revocation_cutoff())

    # The most consequential event in the system: the identity is destroyed and every device
    # revoked, so all history becomes unreadable. If it was not the account holder who did this,
    # this record is the only place it shows up.
    await audit.record(
        mongo_db,
        AuditEvent.PASSWORD_RESET,
        user_id=user.id,
        client_ip=client_identifier(request),
        details={"devices_revoked": True, "identity_destroyed": True},
    )

    return SuccessResponse(
        data={"message": "Password and keys was successfully updated."}
    )


@router.post("/change-password", response_model=SuccessResponse[dict])
async def change_password(
    user_data: PasswordChange,
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    mongo_db: AsyncIOMotorDatabase = Depends(get_mongo_db),
):
    await enforce_rate_limit(
        redis,
        scope="change-password",
        identifier=str(current_user.id),
        limit=CHANGE_PASSWORD_PER_ACCOUNT,
        window_seconds=CHANGE_PASSWORD_WINDOW,
        message="Too many failed attempts. Please wait and try again.",
    )

    if not verify_password(user_data.old_password, current_user.hashed_password):
        raise AppException(401, "INVALID_PASSWORD", "Invalid password.")

    await reset_rate_limit(
        redis,
        scope="change-password",
        identifier=str(current_user.id),
        window_seconds=CHANGE_PASSWORD_WINDOW,
    )

    current_user.hashed_password = get_password_hash(user_data.new_password)

    # Keep the identity keypair — only its wrapping changes. Re-wrapping and the password update
    # share one transaction, so we can never end up with a new password and a bundle still
    # wrapped under the old one (which would lock the user out of their own history).
    if user_data.new_encrypted_private_key is not None:
        current_user.encrypted_private_key = user_data.new_encrypted_private_key

    if user_data.rewrapped_identities:
        await identity_service.rewrap_private_bundles(
            db, current_user.id, user_data.rewrapped_identities
        )

    await db.commit()

    # The cutoff is taken *before* the replacement tokens are minted, so their `iat` is strictly
    # greater and the caller's own new session survives the revocation it just triggered — while
    # every token issued before it, down to the fraction of a second, does not.
    cutoff = revocation_cutoff()
    await redis.setex(f"force_logout:{current_user.id}", 604800, cutoff)

    new_access_token = create_access_token(data={"sub": str(current_user.id)})
    new_refresh_token = create_refresh_token(data={"sub": str(current_user.id)})

    set_token_cookie(response, new_access_token, "access")
    set_token_cookie(response, new_refresh_token, "refresh")

    await audit.record(
        mongo_db,
        AuditEvent.PASSWORD_CHANGED,
        user_id=current_user.id,
        client_ip=client_identifier(request),
        details={"rewrapped_devices": len(user_data.rewrapped_identities or [])},
    )

    return SuccessResponse(data={"message": "Password changed successfully."})
