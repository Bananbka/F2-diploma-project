import redis.asyncio as redis
from app.core.config import settings

redis_client: redis.Redis = None


async def init_redis():
    global redis_client
    redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await redis_client.ping()
        print("Connected to Redis")
    except Exception as e:
        print("Redis connection failed", e)


async def get_redis():
    return redis_client
