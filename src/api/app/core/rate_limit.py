"""Redis-backed rate limiting.

There was none anywhere in the application before this. Login, registration, OTP verification,
password reset, file upload and identity publication were all unbounded, which turned several
otherwise-acceptable designs into real attacks — most sharply the six-digit OTP, whose whole
security argument rests on an attacker getting only a handful of guesses.

A fixed window in Redis rather than a token bucket: it is one INCR plus one EXPIRE, it needs no
per-key state machine, and the worst case (twice the quota across a window boundary) is
irrelevant at these magnitudes.

Redis is a hard dependency of the app already, so a failure here is not "fall through and allow" —
it is a broken deployment. Limits therefore fail closed.
"""

import time
import uuid

from redis.asyncio import Redis

from app.core.config import settings
from app.core.exceptions import AppException

# Header the integration suite's test-only bypass rides on. See
# `Settings.RATE_LIMIT_TEST_BYPASS_TOKEN` for why this is safe to leave in production code: it is
# only ever consulted, and only ever matches, when that setting has been deliberately set, which
# never happens outside a test environment.
TEST_BYPASS_HEADER = "x-ratelimit-test-bypass"


async def enforce_rate_limit(
    redis: Redis,
    *,
    scope: str,
    identifier: str,
    limit: int,
    window_seconds: int,
    message: str = "Too many attempts. Please wait and try again.",
) -> None:
    """Allow `limit` calls per `window_seconds` for one (scope, identifier). Raise 429 beyond it.

    `identifier` should be the most specific stable thing available — a user id or an account
    identifier for authenticated actions, the client address for anonymous ones. Keying anonymous
    limits on the address alone is imperfect behind a shared NAT, which is why the account-scoped
    limits below exist alongside them rather than instead of them.
    """
    if not settings.RATE_LIMIT_ENABLED:
        return

    window = int(time.time()) // window_seconds
    key = f"ratelimit:{scope}:{identifier}:{window}"

    used = await redis.incr(key)
    if used == 1:
        await redis.expire(key, window_seconds)

    if used > limit:
        retry_after = window_seconds - (int(time.time()) % window_seconds)
        raise AppException(
            429,
            "RATE_LIMITED",
            message,
            details={"retry_after_seconds": retry_after},
            headers={"Retry-After": str(retry_after)},
        )


async def reset_rate_limit(
    redis: Redis, *, scope: str, identifier: str, window_seconds: int
) -> None:
    """Clear the current window after a success, so honest users are never penalised for a typo."""
    if not settings.RATE_LIMIT_ENABLED:
        return

    window = int(time.time()) // window_seconds
    await redis.delete(f"ratelimit:{scope}:{identifier}:{window}")


def client_identifier(request) -> str:
    """Best available client address.

    nginx sets X-Forwarded-For, and only the *first* hop of it may be trusted here because the
    rest is client-supplied and trivially forged. Behind the compose setup there is exactly one
    proxy, so the first entry is what nginx observed.

    Test-only exception: the integration suite registers dozens of accounts from one address,
    which is exactly the pattern the IP-keyed limits (`register`, `verify-email`, `login-ip`,
    `forgot-ip`/`reset-ip`) exist to stop, and every request in the suite shares the same real
    address regardless. When `RATE_LIMIT_TEST_BYPASS_TOKEN` is set on the server and the caller's
    request carries a matching `TEST_BYPASS_HEADER`, a fresh random identifier is minted per call
    instead of the real address, so test traffic stops colliding with itself without disabling the
    limiter or trusting anything a real client could forge — the bypass only fires when the exact
    secret configured on this deployment is presented, and that secret is never set outside a test
    environment.
    """
    token = settings.RATE_LIMIT_TEST_BYPASS_TOKEN
    if token and request.headers.get(TEST_BYPASS_HEADER) == token:
        return f"test-bypass:{uuid.uuid4()}"

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()

    return request.client.host if request.client else "unknown"
