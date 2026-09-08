import asyncio
import enum
from typing import Callable

from celery import shared_task
from loguru import logger
from fastapi_mail import FastMail, MessageSchema, ConnectionConfig, MessageType

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
    VALIDATE_CERTS=True
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
        subtype=MessageType.html
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
        subtype=MessageType.html
    )

    fm = FastMail(conf)
    await fm.send_message(message)


class EmailTasks(enum.Enum):
    PASSWORD_RESET = "password_reset"
    EMAIL_VERIFICATION = "email_verification"


@shared_task
def send_email(type_: EmailTasks, email_to: str, **kwargs):
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        logger.warning(f"SMTP is not configured! Simulated email to {email_to}. Kwargs: {kwargs}")
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
    except Exception as e:
        # exc_info matters here. fastapi-mail sends inside an `async with Connection(...)`, so when
        # the server rejects the message its __aexit__ still issues QUIT on the now-dead socket and
        # raises SMTPServerDisconnected("Server not connected"). That replaces the useful error —
        # a 550 quoting the actual reason — with a generic one. Only the full chain shows the cause.
        logger.error(f"Failed to send email to {email_to}: {e!r}", exc_info=True)
        return False
