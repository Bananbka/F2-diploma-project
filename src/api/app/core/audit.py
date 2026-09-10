"""Security audit log.

The proposal names "агрегація аудиту безпеки" as a deliverable and nothing in the codebase
recorded anything: there was no way to answer "when did this account's keys change", "where was
this session opened from", or "who removed that member" — which are the questions an incident
actually turns on.

**What is recorded, and what deliberately is not.** Events are metadata only: who, what, when,
from where. No message content, no key material, no OTP, no password. The server cannot read
message content anyway, and writing key material to a log would undo the point of never storing
it. `details` is for identifiers and reasons, never for secrets.

Records go to MongoDB rather than Postgres. They are append-only documents with a variable shape,
nobody joins against them, and they must not compete for row locks with the transactional tables
they describe — writing an audit row inside the same transaction as a password change would let a
logging failure roll the password change back.

That independence cuts the other way too: **an audit write must never fail the action it
describes**. A failure here is logged and swallowed, because refusing someone's password change
because the audit collection is unreachable is worse than losing one audit record.
"""

import enum
import uuid
from datetime import datetime, timezone

from loguru import logger
from motor.motor_asyncio import AsyncIOMotorDatabase

COLLECTION = "security_audit"

# Kept for a year, then reaped by the Celery task in app/domains/users/tasks.py. Long enough to
# investigate something noticed late, short enough that the log is not itself a growing store of
# personal data about who talked to whom and when.
RETENTION_DAYS = 365


class AuditEvent(str, enum.Enum):
    """Events worth reconstructing after the fact.

    Deliberately narrow. A log that records everything is one nobody reads, and every entry here
    is personal data with a retention cost — so the bar is "an investigation would need this".
    """

    # Authentication and session lifecycle.
    LOGIN_SUCCEEDED = "login_succeeded"
    LOGIN_FAILED = "login_failed"
    LOGOUT = "logout"
    PASSWORD_CHANGED = "password_changed"
    PASSWORD_RESET = "password_reset"
    EMAIL_VERIFIED = "email_verified"
    RATE_LIMITED = "rate_limited"

    # Key lifecycle. The ones that matter most: a key change is what a successful server-side
    # substitution looks like from the outside, so it has to leave a trace independent of the
    # client that noticed the safety number change.
    IDENTITY_PUBLISHED = "identity_published"
    DEVICE_REVOKED = "device_revoked"
    DEVICES_REVOKED_BULK = "devices_revoked_bulk"

    # Membership, because it changes who can read what.
    ENCRYPTION_ENABLED = "encryption_enabled"
    PARTICIPANTS_ADDED = "participants_added"
    PARTICIPANTS_REMOVED = "participants_removed"
    OWNERSHIP_TRANSFERRED = "ownership_transferred"
    CHAT_DELETED = "chat_deleted"


async def record(
    mongo_db: AsyncIOMotorDatabase | None,
    event: AuditEvent,
    *,
    user_id: uuid.UUID | None = None,
    chat_id: uuid.UUID | None = None,
    client_ip: str | None = None,
    details: dict | None = None,
) -> None:
    """Append one audit record. Never raises.

    `mongo_db` is optional so a caller without a handle — a Celery task, a code path that has not
    been threaded through yet — degrades to doing nothing rather than to a crash.
    """
    if mongo_db is None:
        return

    document = {
        "event": event.value,
        "user_id": user_id,
        "chat_id": chat_id,
        "client_ip": client_ip,
        "details": details or {},
        "created_at": datetime.now(timezone.utc),
    }

    try:
        await mongo_db[COLLECTION].insert_one(document)
    except Exception as exc:
        # Swallowed on purpose. The action being audited has already happened, or is about to;
        # failing it now because the log is unavailable trades a real user-facing failure for a
        # missing record.
        logger.error(f"audit write failed for {event.value}: {exc}")
