"""Outbound real-time events: the `EventPublisher` port and its Redis implementation.

Every user has an event stream (`stream:user:{id}`) and a live channel (`user:{id}`). A *durable*
event is appended to the stream and published live in one atomic step, so the live copy carries
the stream id and a reconnecting socket can replay what it missed. An *ephemeral* event (typing,
presence, session revocation) is published live only: replaying "X is typing" minutes later would
be wrong, and none of it can be recovered from the HTTP API anyway.

Delivery is still not acknowledged. The stream gives recovery of missed events within its TTL and
cap, not confirmed delivery; the client dedups by message id.
"""

import re
import uuid
from collections.abc import Iterable
from typing import Protocol

from fastapi import Depends
from redis.asyncio import Redis
from redis.commands.core import AsyncScript

from app.core.config import settings
from app.domains.messages.schemas.ws_schemas import WSMessageEnvelope
from app.infrastructure.redis import get_events_redis

STREAM_KEY_PREFIX = "stream:user:"
CHANNEL_PREFIX = "user:"
STREAM_FIELD = "e"


def stream_key(user_id: uuid.UUID | str) -> str:
    return f"{STREAM_KEY_PREFIX}{user_id}"


def channel_name(user_id: uuid.UUID | str) -> str:
    return f"{CHANNEL_PREFIX}{user_id}"


def with_stream_id(event_json: str, stream_id: str) -> str:
    """Add `stream_id` to a serialized envelope.

    The stream stores the envelope without it (the entry id *is* the stream id, and is unknown
    until XADD returns), so the id is spliced in textually. `model_dump_json` always yields a
    single JSON object ending in `}`; the Lua script does the identical splice for the live copy.
    """
    return f'{event_json[:-1]},"stream_id":"{stream_id}"}}'


_TRAILING_STREAM_ID = re.compile(r',"stream_id":"([0-9]+)-([0-9]+)"\}$')
# ASCII digits only: `\d` also matches Arabic-Indic and other Unicode digits, which `int()` accepts
# but Redis does not.
STREAM_ID_PATTERN = re.compile(r"[0-9]{1,20}-[0-9]{1,20}")
_UINT64_MAX = 2**64 - 1


def parse_stream_id(value: str) -> tuple[int, int] | None:
    """`"1700000000000-3"` -> `(1700000000000, 3)`; `None` if it is not a well-formed id."""
    if not STREAM_ID_PATTERN.fullmatch(value):
        return None
    ms, seq = (int(part) for part in value.split("-"))
    if ms > _UINT64_MAX or seq > _UINT64_MAX:
        return None
    return ms, seq


def extract_stream_id(event_json: str) -> tuple[int, int] | None:
    """Stream id of a live event, or `None` for an ephemeral one.

    The id is spliced at the very end of the document, and any `"` inside a payload string is
    escaped, so a payload cannot forge a match for this anchored pattern.
    """
    m = _TRAILING_STREAM_ID.search(event_json)
    return (int(m.group(1)), int(m.group(2))) if m else None


def gap_key(user_id: uuid.UUID | str) -> str:
    return f"stream-gap:{user_id}"


# XADD must come before PUBLISH because the live copy embeds the id XADD returns, and a pipeline
# only hands back results at execute time. A second round trip would work, but would also let a
# crash between the two leave an entry that was never published, or let another writer interleave.
# A script runs atomically, so for each recipient the stream and the channel see events in the
# same order, which is what the replay/live boundary in `ws_router` relies on.
#
# If the event cannot be stored (over the size cap, or XADD refused) it is still published live, without a stream_id, and the user's gap marker
# is set to the current time in ms. A reconnecting client with a cursor at or before that time is
# told to resync, so the hole in the stream is never silent. The events Redis evicts under
# memory pressure (allkeys-lru) rather than refusing writes, so a refused XADD is rare; the marker is
# itself a key that eviction can remove, which is the documented residual case.
_APPEND_AND_PUBLISH = """
local json = ARGV[3]
local id = false
if #json <= tonumber(ARGV[5]) then
  local ok, res = pcall(redis.call, 'XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], '*', ARGV[4], json)
  if ok then
    id = res
    redis.call('EXPIRE', KEYS[1], ARGV[2])
  else
    redis.log(redis.LOG_WARNING, 'event stream XADD failed for ' .. KEYS[1])
  end
end
if id then
  redis.call('PUBLISH', KEYS[2], string.sub(json, 1, -2) .. ',"stream_id":"' .. id .. '"}')
  return id
end
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ok = pcall(redis.call, 'SET', KEYS[3], tostring(now_ms), 'EX', ARGV[2])
if not ok then
  redis.log(redis.LOG_WARNING, 'event stream gap marker could not be set for ' .. KEYS[1])
end
redis.call('PUBLISH', KEYS[2], json)
return false
"""

# Registered once per process. An AsyncScript only needs a client to compute its encoding, and the
# client is passed again at call time, so one instance serves every request.
_script: AsyncScript | None = None

# Recipients per pipeline: bounds the size of one round trip for a very large channel.
FAN_OUT_CHUNK = 500


def _get_script(redis: Redis) -> AsyncScript:
    global _script
    if _script is None:
        _script = redis.register_script(_APPEND_AND_PUBLISH)
    return _script


def _chunks(items: list) -> list[list]:
    return [items[i : i + FAN_OUT_CHUNK] for i in range(0, len(items), FAN_OUT_CHUNK)]


class EventPublisher(Protocol):
    """What services and routers may depend on to push events to users."""

    async def publish_durable(
        self, envelope: WSMessageEnvelope, recipient_ids: Iterable[uuid.UUID]
    ) -> None: ...

    async def publish_ephemeral(
        self, envelope: WSMessageEnvelope, recipient_ids: Iterable[uuid.UUID]
    ) -> None: ...


class RedisEventPublisher:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis
        self._append_and_publish = _get_script(redis)

    @staticmethod
    def _dump(envelope: WSMessageEnvelope) -> str:
        return envelope.model_dump_json(exclude={"stream_id"})

    async def publish_durable(
        self, envelope: WSMessageEnvelope, recipient_ids: Iterable[uuid.UUID]
    ) -> None:
        recipients = set(recipient_ids)
        if not recipients:
            return

        event_json = self._dump(envelope)
        # transaction=False: each script is already atomic and recipients are independent, so
        # MULTI would only add blocking.
        for chunk in _chunks(list(recipients)):
            async with self._redis.pipeline(transaction=False) as pipe:
                for recipient_id in chunk:
                    await self._append_and_publish(
                        keys=[
                            stream_key(recipient_id),
                            channel_name(recipient_id),
                            gap_key(recipient_id),
                        ],
                        args=[
                            settings.EVENT_STREAM_MAXLEN,
                            settings.EVENT_STREAM_TTL_SECONDS,
                            event_json,
                            STREAM_FIELD,
                            settings.EVENT_STREAM_MAX_ENTRY_BYTES,
                        ],
                        client=pipe,
                    )
                await pipe.execute()

    async def publish_ephemeral(
        self, envelope: WSMessageEnvelope, recipient_ids: Iterable[uuid.UUID]
    ) -> None:
        recipients = set(recipient_ids)
        if not recipients:
            return

        event_json = self._dump(envelope)
        for chunk in _chunks(list(recipients)):
            async with self._redis.pipeline(transaction=False) as pipe:
                for recipient_id in chunk:
                    pipe.publish(channel_name(recipient_id), event_json)
                await pipe.execute()


async def get_event_publisher(
    redis: Redis = Depends(get_events_redis),
) -> EventPublisher:
    """Publishers talk to the events Redis only, never to the denylist instance."""
    return RedisEventPublisher(redis)
