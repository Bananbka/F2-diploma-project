"""Test access to one-time codes.

Redis holds only an HMAC of each code, so a test can no longer read the code back. It plants a
known one instead: the stored digest is replaced with the digest of `KNOWN_OTP`, computed with the
same function and secret the application uses. The code only reaches a user by email and there is
no mail server in the test environment, so this stands in for reading the inbox without adding a
back door to the application.
"""

from redis.asyncio import Redis

from app.core.config import settings
from app.domains.users.services.auth_service import otp_digest

KNOWN_OTP = "424242"


async def plant_known_otp(key: str) -> str:
    """`key` is the Redis key, `{naming}:{identificator}`; the digest is bound to both parts."""
    naming, identificator = key.split(":", 1)
    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        ttl = await redis.ttl(key)
        assert ttl > 0, f"no OTP stored at {key}"
        await redis.setex(key, ttl, otp_digest(naming, identificator, KNOWN_OTP))
        return KNOWN_OTP
    finally:
        await redis.aclose()
