import hmac
import secrets
import uuid

from redis.asyncio import Redis

from app.core.exceptions import AppException

OTP_TTL_SECONDS = 900

# A six-digit code is only a million possibilities. That is fine when an attacker gets five
# guesses and hopeless when they get unlimited ones, which is exactly what this used to allow:
# `check_otp` deleted the code on success and left it sitting there on failure, with no counter
# and no rate limit in front of the endpoint. Brute-forcing an account took minutes.
MAX_OTP_ATTEMPTS = 5


def _code_key(naming: str, identificator) -> str:
    return f"{naming}:{identificator}"


def _attempts_key(naming: str, identificator) -> str:
    return f"{naming}:attempts:{identificator}"


async def generate_otp(redis: Redis, naming: str, identificator: uuid.UUID | str) -> str:
    """Issue a fresh one-time code, resetting the attempt counter with it.

    `secrets` rather than `random`: the latter is a Mersenne Twister seeded from the clock, and
    its output is predictable from a modest number of observed values — for a code that guards
    password reset, that is a real distinction, not a formality.
    """
    otp = f"{secrets.randbelow(1_000_000):06d}"

    await redis.setex(_code_key(naming, identificator), OTP_TTL_SECONDS, otp)
    await redis.delete(_attempts_key(naming, identificator))

    return otp


async def check_otp(redis: Redis, naming: str, identificator: uuid.UUID | str, otp: str) -> bool:
    """Verify a code, burning an attempt whether or not it matches.

    The code is destroyed after `MAX_OTP_ATTEMPTS` failures, so a wrong guess costs the attacker
    the whole code rather than nothing. Comparison is constant-time: a byte-by-byte early exit
    leaks the correct prefix through timing, which reduces a million-guess search to sixty.
    """
    code_key = _code_key(naming, identificator)
    attempts_key = _attempts_key(naming, identificator)

    true_otp = await redis.get(code_key)
    if not true_otp:
        return False

    attempts = await redis.incr(attempts_key)
    if attempts == 1:
        await redis.expire(attempts_key, OTP_TTL_SECONDS)

    if attempts > MAX_OTP_ATTEMPTS:
        await redis.delete(code_key)
        raise AppException(
            429, "OTP_ATTEMPTS_EXCEEDED",
            "Too many incorrect codes. Request a new one.",
        )

    if not hmac.compare_digest(str(true_otp), str(otp)):
        return False

    await redis.delete(code_key)
    await redis.delete(attempts_key)
    return True
