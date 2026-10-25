import asyncio
import enum
from datetime import datetime, timedelta, timezone

from smtplib import SMTPException

import aiosmtplib
from celery import shared_task
from fastapi_mail.errors import ConnectionErrors
from fastapi_mail import ConnectionConfig, FastMail, MessageSchema, MessageType
from loguru import logger
from motor.motor_asyncio import AsyncIOMotorClient

from app.core import audit
from app.core.config import settings

conf = ConnectionConfig(
    MAIL_USERNAME=settings.SMTP_USER,
    MAIL_PASSWORD=settings.SMTP_PASSWORD,
    MAIL_FROM=settings.SMTP_USER,
    MAIL_PORT=settings.SMTP_PORT,
    MAIL_SERVER=settings.SMTP_HOST,
    MAIL_FROM_NAME=settings.EMAILS_FROM_NAME,
    MAIL_STARTTLS=True,
    MAIL_SSL_TLS=False,
    USE_CREDENTIALS=True,
    VALIDATE_CERTS=True,
)


async def send_password_reset_email(email_to: str, otp: str):
    html_content = f"""
    <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Відновлення пароля - Mess&Gags</h2>
        <p>Ваш код підтвердження:</p>
        <h1 style="color: #4CAF50; letter-spacing: 5px;">{otp}</h1>
        <p style="color: red; font-size: 12px;">
            Увага: відновлення пароля скине ваші старі E2E ключі.
        </p>
    </div>
    """

    message = MessageSchema(
        subject="Відновлення пароля",
        recipients=[email_to],
        body=html_content,
        subtype=MessageType.html,
    )

    fm = FastMail(conf)
    await fm.send_message(message)


async def send_email_verification_email(email_to: str, otp: str):
    html_content = f"""
    <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Підтвердження пошти - Mess&Gags</h2>
        <p>Ваш код підтвердження:</p>
        <h1 style="color: #4CAF50; letter-spacing: 5px;">{otp}</h1>
        <p style="color: red; font-size: 12px;">
            Увага: ляляля.
        </p>
    </div>
    """

    message = MessageSchema(
        subject="Підтвердження пошти",
        recipients=[email_to],
        body=html_content,
        subtype=MessageType.html,
    )

    fm = FastMail(conf)
    await fm.send_message(message)


class EmailTasks(enum.Enum):
    PASSWORD_RESET = "password_reset"
    EMAIL_VERIFICATION = "email_verification"


def _smtp_code(error: BaseException) -> int | None:
    """The SMTP reply code carried by an error, if any (looking through wrapped causes)."""
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        code = getattr(error, "code", None)
        if isinstance(code, int):
            return code
        code = getattr(error, "smtp_code", None)
        if isinstance(code, int):
            return code
        error = error.__cause__ or error.__context__
    return None


def _is_transient_mail_error(error: BaseException) -> bool:
    """Connection-level failures and SMTP 4xx replies are worth retrying; 5xx never are."""
    code = _smtp_code(error)
    if code is not None:
        return 400 <= code < 500
    return True


# Transient delivery failures are retried with exponential backoff, then the task fails loudly.
# Without this a single SMTP hiccup silently dropped a verification or reset code.
@shared_task(
    autoretry_for=(SMTPException, OSError),
    max_retries=3,
    retry_backoff=True,
)
def send_email(type_: EmailTasks, email_to: str, **kwargs):
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        logger.warning(
            f"SMTP is not configured! Simulated email to {email_to}. Kwargs: {kwargs}"
        )
        return False

    try:
        match type_:
            case EmailTasks.PASSWORD_RESET.value:
                func = send_password_reset_email
            case EmailTasks.EMAIL_VERIFICATION.value:
                func = send_email_verification_email
            case _:
                raise ValueError("Unknown email type")

        asyncio.run(func(email_to, **kwargs))
        logger.info(f"Successfully sent {type_} HTML-email to {email_to}")
        return True
    except (aiosmtplib.SMTPException, ConnectionErrors, SMTPException, OSError) as e:
        # Only transient failures are retried. fastapi-mail/aiosmtplib raise their own hierarchy,
        # which is not smtplib's, so a retryable one is re-raised as smtplib.SMTPException for
        # the autoretry policy. A permanent rejection (5xx such as 550 or 535 bad credentials)
        # will fail identically every time, so it is logged below and not retried.
        if _is_transient_mail_error(e):
            logger.warning(f"Transient failure sending to {email_to}, will retry: {e!r}")
            if isinstance(e, (SMTPException, OSError)):
                raise
            raise SMTPException(str(e)) from e
        logger.error(f"Failed to send email to {email_to}: {e!r}", exc_info=True)
        return False
    except Exception as e:
        # exc_info matters here. fastapi-mail sends inside an `async with Connection(...)`, so when
        # the server rejects the message its __aexit__ still issues QUIT on the now-dead socket and
        # raises SMTPServerDisconnected("Server not connected"). That replaces the useful error —
        # a 550 quoting the actual reason — with a generic one. Only the full chain shows the cause.
        logger.error(f"Failed to send email to {email_to}: {e!r}", exc_info=True)
        return False


async def _prune_security_audit() -> int:
    """Drop audit records past their retention window.

    The log is personal data — who signed in, from where, who they were in a chat with — so it
    cannot simply accumulate. A year is long enough to investigate something noticed late and
    short enough that the log does not become a permanent social graph of its own.
    """
    client = AsyncIOMotorClient(settings.MONGO_URL, uuidRepresentation="standard")

    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=audit.RETENTION_DAYS)

        result = await client[settings.MONGO_DB_NAME][audit.COLLECTION].delete_many(
            {"created_at": {"$lt": cutoff}}
        )
        return result.deleted_count
    finally:
        client.close()


@shared_task
def prune_security_audit_task():
    count = asyncio.run(_prune_security_audit())
    logger.info(f"AUDIT RETENTION: pruned {count} records")
    return count
