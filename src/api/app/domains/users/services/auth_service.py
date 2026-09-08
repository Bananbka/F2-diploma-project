import random
import uuid

from redis.asyncio import Redis


async def generate_otp(redis: Redis, naming: str, identificator: uuid.UUID | str) -> str:
    redis_key = f"{naming}:{identificator}"
    otp = f"{random.randint(100000, 999999)}"
    await redis.setex(redis_key, 900, otp)
    return otp


async def check_otp(redis: Redis, naming: str, identificator: uuid.UUID | str, otp: str) -> bool:
    redis_key = f"{naming}:{identificator}"
    true_otp = await redis.get(redis_key)

    if true_otp and true_otp == otp:
        await redis.delete(redis_key)
        return True

    return False
