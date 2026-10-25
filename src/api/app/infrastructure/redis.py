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


# Events Redis: WebSocket fan-out, per-user streams and gap markers. A different instance from
# `redis_client` on purpose -- see EVENTS_REDIS_URL in config.py.
events_redis_client: redis.Redis = None


async def init_events_redis():
    global events_redis_client
    events_redis_client = redis.from_url(settings.EVENTS_REDIS_URL, decode_responses=True)
    try:
        await events_redis_client.ping()
        print("Connected to events Redis")
    except Exception as e:
        print("Events Redis connection failed", e)


async def get_events_redis():
    return events_redis_client
