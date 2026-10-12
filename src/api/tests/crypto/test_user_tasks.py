"""Celery tasks in `app/domains/users/tasks.py`.

`test_rotation_tasks.py` already covers the crypto tasks; these two had zero coverage. Audit
pruning is exercised against a real retention cutoff (inserting documents directly, since nothing
else in the app writes audit records with an arbitrary `created_at`); the email task is exercised
only on its two branches that never touch a real SMTP server — there is no mail server in this
test environment, so actual delivery is out of scope.
"""

import uuid
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient

from app.core import audit
from app.core.config import settings as app_settings
from app.domains.users.tasks import EmailTasks, _prune_security_audit, send_email


async def _audit_collection():
    client = AsyncIOMotorClient(app_settings.MONGO_URL, uuidRepresentation="standard")
    return client, client[app_settings.MONGO_DB_NAME][audit.COLLECTION]


async def test_prune_security_audit_deletes_only_records_past_retention():
    client, collection = await _audit_collection()
    try:
        old_id, recent_id = uuid.uuid4(), uuid.uuid4()
        now = datetime.now(timezone.utc)

        await collection.insert_one(
            {
                "event": "login_succeeded",
                "user_id": old_id,
                "chat_id": None,
                "client_ip": "203.0.113.5",
                "details": {},
                "created_at": now - timedelta(days=audit.RETENTION_DAYS + 1),
            }
        )
        await collection.insert_one(
            {
                "event": "login_succeeded",
                "user_id": recent_id,
                "chat_id": None,
                "client_ip": "203.0.113.5",
                "details": {},
                "created_at": now - timedelta(days=1),
            }
        )

        deleted = await _prune_security_audit()
        assert deleted >= 1

        assert await collection.find_one({"user_id": old_id}) is None
        assert await collection.find_one({"user_id": recent_id}) is not None
    finally:
        # Clean up regardless of outcome, so a failure here doesn't leave fixture data behind
        # for the next run.
        await collection.delete_many({"user_id": {"$in": [old_id, recent_id]}})
        client.close()


async def test_prune_security_audit_is_a_noop_when_nothing_is_old_enough():
    client, collection = await _audit_collection()
    try:
        recent_id = uuid.uuid4()
        await collection.insert_one(
            {
                "event": "logout",
                "user_id": recent_id,
                "chat_id": None,
                "client_ip": None,
                "details": {},
                "created_at": datetime.now(timezone.utc),
            }
        )

        await _prune_security_audit()

        assert await collection.find_one({"user_id": recent_id}) is not None
    finally:
        await collection.delete_many({"user_id": recent_id})
        client.close()


def _without_smtp_credentials():
    """Context manager-less save/restore pair, matching this suite's existing style of mutating
    `settings` directly (see `test_rate_limit.py`'s `_limits_on` fixture) rather than reaching for
    a monkeypatch fixture this plain-function test style doesn't use elsewhere."""
    return app_settings.SMTP_USER, app_settings.SMTP_PASSWORD


async def test_send_email_returns_false_and_never_sends_when_smtp_is_unconfigured():
    original = _without_smtp_credentials()
    try:
        app_settings.SMTP_USER = None
        app_settings.SMTP_PASSWORD = None

        result = send_email(EmailTasks.EMAIL_VERIFICATION.value, "nobody@example.com", otp="123456")
        assert result is False
    finally:
        app_settings.SMTP_USER, app_settings.SMTP_PASSWORD = original


async def test_send_email_rejects_an_unknown_email_type():
    """An unknown type must raise inside the task's own try/except and come back as `False`,
    never escape as an unhandled exception — this path never reaches `fm.send_message`, since the
    `match` statement raises before the code that would call it.
    """
    original = _without_smtp_credentials()
    try:
        app_settings.SMTP_USER = "test-user"
        app_settings.SMTP_PASSWORD = "test-password"

        result = send_email("not_a_real_email_type", "nobody@example.com")
        assert result is False
    finally:
        app_settings.SMTP_USER, app_settings.SMTP_PASSWORD = original
