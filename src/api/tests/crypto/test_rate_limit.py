"""Unit tests for the Redis-backed limiter.

The integration suite runs with RATE_LIMIT_ENABLED=false — it registers dozens of accounts from
one address, which is precisely the pattern the registration limit exists to stop. So the limiter
is exercised directly here instead, against the real Redis, rather than being left untested
because the suite that would have covered it has to disable it.
"""
import uuid

import pytest
from redis.asyncio import Redis

from app.core.config import settings
from app.core.exceptions import AppException
from app.core.rate_limit import client_identifier, enforce_rate_limit, reset_rate_limit


class _FakeRequest:
    def __init__(self, headers=None, host=None):
        self.headers = headers or {}
        self.client = type("C", (), {"host": host})() if host else None


@pytest.fixture
async def redis():
    client = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture(autouse=True)
def _limits_on():
    """The suite runs with limiting off; these tests need it on regardless."""
    original = settings.RATE_LIMIT_ENABLED
    settings.RATE_LIMIT_ENABLED = True
    yield
    settings.RATE_LIMIT_ENABLED = original


async def test_allows_up_to_the_limit_then_refuses(redis):
    identifier = uuid.uuid4().hex

    for _ in range(3):
        await enforce_rate_limit(
            redis, scope="test", identifier=identifier, limit=3, window_seconds=60
        )

    with pytest.raises(AppException) as excinfo:
        await enforce_rate_limit(
            redis, scope="test", identifier=identifier, limit=3, window_seconds=60
        )

    assert excinfo.value.status_code == 429
    assert excinfo.value.error_code == "RATE_LIMITED"
    # The client needs to know how long to wait, or it will simply hammer the endpoint.
    assert excinfo.value.details["retry_after_seconds"] > 0


async def test_identifiers_are_counted_independently(redis):
    first, second = uuid.uuid4().hex, uuid.uuid4().hex

    await enforce_rate_limit(redis, scope="test", identifier=first, limit=1, window_seconds=60)

    with pytest.raises(AppException):
        await enforce_rate_limit(redis, scope="test", identifier=first, limit=1, window_seconds=60)

    # One account being attacked must not lock everyone else out.
    await enforce_rate_limit(redis, scope="test", identifier=second, limit=1, window_seconds=60)


async def test_scopes_are_counted_independently(redis):
    identifier = uuid.uuid4().hex

    await enforce_rate_limit(redis, scope="a", identifier=identifier, limit=1, window_seconds=60)
    await enforce_rate_limit(redis, scope="b", identifier=identifier, limit=1, window_seconds=60)


async def test_reset_clears_the_window(redis):
    identifier = uuid.uuid4().hex

    await enforce_rate_limit(redis, scope="test", identifier=identifier, limit=1, window_seconds=60)
    await reset_rate_limit(redis, scope="test", identifier=identifier, window_seconds=60)

    # This is what stops a user who mistyped their password twice being locked out of their own
    # account for the rest of the window after they finally get it right.
    await enforce_rate_limit(redis, scope="test", identifier=identifier, limit=1, window_seconds=60)


async def test_disabled_limiter_never_refuses(redis):
    settings.RATE_LIMIT_ENABLED = False
    identifier = uuid.uuid4().hex

    for _ in range(10):
        await enforce_rate_limit(
            redis, scope="test", identifier=identifier, limit=1, window_seconds=60
        )


def test_client_identifier_prefers_the_first_forwarded_hop():
    """Only the first entry is trustworthy — nginx appends it, the rest is client-supplied."""
    request = _FakeRequest(headers={"x-forwarded-for": "203.0.113.7, 10.0.0.1"}, host="10.0.0.2")

    assert client_identifier(request) == "203.0.113.7"


def test_client_identifier_falls_back_to_the_peer_address():
    assert client_identifier(_FakeRequest(host="198.51.100.4")) == "198.51.100.4"
    assert client_identifier(_FakeRequest()) == "unknown"
