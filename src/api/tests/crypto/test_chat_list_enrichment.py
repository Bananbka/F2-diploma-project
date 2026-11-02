"""Chat-list preview and unread count, `chat_services.enrich_chats_with_mongo_data`.

Exercised against the real Mongo with documents inserted directly (random chat ids, removed
afterwards), using stand-in chat objects: the function only reads a handful of attributes from
them, and building real Postgres rows would test nothing about the Mongo side.
"""

import uuid
from types import SimpleNamespace

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import settings as app_settings
from app.domains.chats.models import ChatType
from app.domains.chats.services.chat_services import enrich_chats_with_mongo_data

ME = uuid.uuid4()
OTHER = uuid.uuid4()


def _chat(chat_id, **overrides):
    base = dict(
        id=chat_id,
        title="t",
        avatar_url=None,
        chat_type=ChatType.GROUP,
        participants=[],
        created_at=None,
        updated_at=None,
        history_start_message_id=None,
        last_read_message_id=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


async def _run(chat_id, docs, **chat_overrides):
    """Insert `docs` (list of (sender, is_control)) in order; return (ids, enriched entry)."""
    client = AsyncIOMotorClient(app_settings.MONGO_URL, uuidRepresentation="standard")
    try:
        db = client[app_settings.MONGO_DB_NAME]
        ids = [ObjectId() for _ in docs]
        if docs:
            await db["messages"].insert_many(
                [
                    {"_id": oid, "chat_id": chat_id, "sender_id": sender, "is_control": control}
                    for oid, (sender, control) in zip(ids, docs)
                ]
            )
        try:
            # Overrides may reference ids by index.
            resolved = {
                k: (str(ids[v]) if isinstance(v, int) else v)
                for k, v in chat_overrides.items()
            }
            out = await enrich_chats_with_mongo_data(db, ME, [_chat(chat_id, **resolved)])
            return ids, out[0]
        finally:
            await db["messages"].delete_many({"chat_id": chat_id})
    finally:
        client.close()


async def test_unread_counts_others_and_preview_is_newest():
    ids, entry = await _run(uuid.uuid4(), [(OTHER, False), (OTHER, False), (ME, False)])

    assert entry["unread_count"] == 2, "own messages are never unread"
    assert entry["last_message"]["_id"] == str(ids[2]), "preview is the newest, stringified"


async def test_empty_chat_has_no_preview_and_zero_unread():
    _, entry = await _run(uuid.uuid4(), [])

    assert entry["unread_count"] == 0
    assert entry["last_message"] is None


async def test_control_messages_are_neither_unread_nor_preview():
    ids, entry = await _run(uuid.uuid4(), [(OTHER, False), (OTHER, True), (OTHER, True)])

    assert entry["unread_count"] == 1
    assert entry["last_message"]["_id"] == str(ids[0])


async def test_history_floor_hides_earlier_messages():
    ids, entry = await _run(
        uuid.uuid4(),
        [(OTHER, False), (OTHER, False), (OTHER, False)],
        history_start_message_id=1,
    )

    assert entry["unread_count"] == 1, "only messages after the floor count"
    assert entry["last_message"]["_id"] == str(ids[2])


async def test_floor_at_newest_message_leaves_nothing():
    ids = [ObjectId() for _ in range(2)]
    client = AsyncIOMotorClient(app_settings.MONGO_URL, uuidRepresentation="standard")
    chat_id = uuid.uuid4()
    try:
        db = client[app_settings.MONGO_DB_NAME]
        await db["messages"].insert_many(
            [{"_id": oid, "chat_id": chat_id, "sender_id": OTHER} for oid in ids]
        )
        try:
            chat = _chat(chat_id, history_start_message_id=str(ids[1]))
            entry = (await enrich_chats_with_mongo_data(db, ME, [chat]))[0]
        finally:
            await db["messages"].delete_many({"chat_id": chat_id})
    finally:
        client.close()

    assert entry["unread_count"] == 0
    assert entry["last_message"] is None


async def test_invalid_floor_fails_closed():
    _, entry = await _run(
        uuid.uuid4(), [(OTHER, False)], history_start_message_id="not-an-objectid"
    )

    assert entry["unread_count"] == 0
    assert entry["last_message"] is None, "an unusable floor must not expose history"


async def test_read_cursor_limits_unread():
    ids, entry = await _run(
        uuid.uuid4(),
        [(OTHER, False), (OTHER, False), (OTHER, False)],
        last_read_message_id=1,
    )

    assert entry["unread_count"] == 1
    assert entry["last_message"]["_id"] == str(ids[2])


async def test_read_cursor_below_the_floor_does_not_resurrect_hidden_messages():
    _, entry = await _run(
        uuid.uuid4(),
        [(OTHER, False), (OTHER, False), (OTHER, False)],
        history_start_message_id=1,
        last_read_message_id=0,
    )

    assert entry["unread_count"] == 1


async def test_invalid_read_cursor_counts_everything_in_scope():
    _, entry = await _run(
        uuid.uuid4(), [(OTHER, False), (OTHER, False)], last_read_message_id="garbage"
    )

    assert entry["unread_count"] == 2
