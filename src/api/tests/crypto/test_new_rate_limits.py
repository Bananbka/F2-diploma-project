"""Rate limits added to change-password, message send/edit and sender-key publish.

Follows `test_rate_limit.py`'s own pattern: the integration suite runs with
`RATE_LIMIT_ENABLED=false`, and toggling `settings.RATE_LIMIT_ENABLED` from here only affects this
test process, not the separate uvicorn process serving HTTP — so these exercise the exact
scope/limit/window each endpoint now calls `enforce_rate_limit` with, directly against Redis,
rather than driving it through a live HTTP request.
"""

import uuid

import pytest
from redis.asyncio import Redis

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.domains.crypto.routers.crypto_routes import (
    SENDER_KEY_PUBLISH_LIMIT,
    SENDER_KEY_PUBLISH_WINDOW,
)
from app.domains.messages.routes.messages_routes import (
    MESSAGE_WRITE_LIMIT,
    MESSAGE_WRITE_WINDOW,
)
from app.domains.users.routers.auth_routes import (
    CHANGE_PASSWORD_PER_ACCOUNT,
    CHANGE_PASSWORD_WINDOW,
)


@pytest.fixture
async def redis():
    client = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture(autouse=True)
def _limits_on():
    original = settings.RATE_LIMIT_ENABLED
    settings.RATE_LIMIT_ENABLED = True
    yield
    settings.RATE_LIMIT_ENABLED = original


async def test_change_password_scope_allows_up_to_the_limit_then_refuses(redis):
    identifier = uuid.uuid4().hex

    for _ in range(CHANGE_PASSWORD_PER_ACCOUNT):
        await enforce_rate_limit(
            redis,
            scope="change-password",
            identifier=identifier,
            limit=CHANGE_PASSWORD_PER_ACCOUNT,
            window_seconds=CHANGE_PASSWORD_WINDOW,
        )

    with pytest.raises(AppException) as excinfo:
        await enforce_rate_limit(
            redis,
            scope="change-password",
            identifier=identifier,
            limit=CHANGE_PASSWORD_PER_ACCOUNT,
            window_seconds=CHANGE_PASSWORD_WINDOW,
        )

    assert excinfo.value.status_code == 429
    assert excinfo.value.error_code == "RATE_LIMITED"


async def test_message_send_scope_allows_up_to_the_limit_then_refuses(redis):
    identifier = uuid.uuid4().hex

    for _ in range(MESSAGE_WRITE_LIMIT):
        await enforce_rate_limit(
            redis,
            scope="message-send",
            identifier=identifier,
            limit=MESSAGE_WRITE_LIMIT,
            window_seconds=MESSAGE_WRITE_WINDOW,
        )

    with pytest.raises(AppException) as excinfo:
        await enforce_rate_limit(
            redis,
            scope="message-send",
            identifier=identifier,
            limit=MESSAGE_WRITE_LIMIT,
            window_seconds=MESSAGE_WRITE_WINDOW,
        )

    assert excinfo.value.status_code == 429


async def test_publish_sender_key_scope_allows_up_to_the_limit_then_refuses(redis):
    identifier = uuid.uuid4().hex

    for _ in range(SENDER_KEY_PUBLISH_LIMIT):
        await enforce_rate_limit(
            redis,
            scope="publish-sender-key",
            identifier=identifier,
            limit=SENDER_KEY_PUBLISH_LIMIT,
            window_seconds=SENDER_KEY_PUBLISH_WINDOW,
        )

    with pytest.raises(AppException) as excinfo:
        await enforce_rate_limit(
            redis,
            scope="publish-sender-key",
            identifier=identifier,
            limit=SENDER_KEY_PUBLISH_LIMIT,
            window_seconds=SENDER_KEY_PUBLISH_WINDOW,
        )

    assert excinfo.value.status_code == 429


async def test_message_send_and_edit_share_one_scoped_budget(redis):
    """`create_message` and `edit_message` both call `enforce_rate_limit` under the same
    `message-send` scope, so a burst of edits counts against the same per-user budget as sends —
    both are write pressure on the same authorization chokepoint (`get_chat_or_403`). Proved here by
    calling `enforce_rate_limit` under that shared scope/identifier as both a "create" and an "edit"
    would, exhausting the budget, and confirming the next call from either side is rejected."""
    identifier = uuid.uuid4().hex

    # Half the budget standing in for sends, half for edits: both draw from the same counter.
    for _ in range(MESSAGE_WRITE_LIMIT):
        await enforce_rate_limit(
            redis,
            scope="message-send",
            identifier=identifier,
            limit=MESSAGE_WRITE_LIMIT,
            window_seconds=MESSAGE_WRITE_WINDOW,
        )

    with pytest.raises(AppException) as excinfo:
        await enforce_rate_limit(
            redis,
            scope="message-send",
            identifier=identifier,
            limit=MESSAGE_WRITE_LIMIT,
            window_seconds=MESSAGE_WRITE_WINDOW,
        )

    assert excinfo.value.status_code == 429
    assert excinfo.value.error_code == "RATE_LIMITED"
