import asyncio
from datetime import datetime, timezone, timedelta

from celery import shared_task
from motor.motor_asyncio import AsyncIOMotorClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.domains.chats.models import Chat
from app.domains.stickers.models import Sticker
from app.domains.users.models import User
from app.infrastructure.minio import minio_manager

ORPHAN_AGE = timedelta(hours=24)


async def _sweep_bucket(bucket_name: str, active_keys: set[str]) -> int:
    """Delete every object in `bucket_name` older than `ORPHAN_AGE` that isn't in `active_keys`."""
    deleted_count = 0
    async with minio_manager.get_client() as client:
        paginator = client.get_paginator('list_objects_v2')

        async for page in paginator.paginate(Bucket=bucket_name):
            if 'Contents' not in page:
                continue

            for obj in page['Contents']:
                key = obj['Key']
                last_modified = obj['LastModified']

                age = datetime.now(timezone.utc) - last_modified

                if age > ORPHAN_AGE:
                    if key not in active_keys:
                        print(f"MINIO GARBAGE COLLECTOR: DELETING ORPHAN {key} FROM {bucket_name}")
                        await client.delete_object(Bucket=bucket_name, Key=key)
                        deleted_count += 1

    return deleted_count


async def cleanup_minio_orphans():
    print("MINIO GARBAGE COLLECTOR: START MINIO CLEANUP")

    mongo_client = AsyncIOMotorClient(settings.MONGO_URL)
    db = mongo_client[settings.MONGO_DB_NAME]
    collection = db["messages"]

    active_keys = set()
    cursor = collection.find({"attachments": {"$ne": None}})

    async for msg in cursor:
        for att in msg.get("attachments", []):
            url = att.get("url")
            if url:
                key = url.split("/")[-1]
                active_keys.add(key)

    mongo_client.close()

    print(f"MINIO GARBAGE COLLECTOR: FOUND {len(active_keys)} ACTIVE MESSAGE KEYS")

    deleted_count = await _sweep_bucket(settings.MINIO_MESSAGE_BUCKET, active_keys)

    print(f"MINIO GARBAGE COLLECTOR: FINISHED MESSAGE BUCKET. DELETED {deleted_count} ORPHANS")


async def cleanup_minio_avatar_orphans():
    """Sweep the avatar bucket for objects no longer referenced by any user or chat avatar.

    Unlike the message bucket, avatars have no Mongo document to track them — they are set
    directly on `User.avatar_url` / `Chat.avatar_url` in Postgres. `PATCH /profile/me` deletes the
    old object synchronously on replace, but this sweep is the safety net for anything that slips
    through (a crashed request between commit and delete, an avatar set some other way, etc.).
    """
    print("MINIO GARBAGE COLLECTOR: START AVATAR CLEANUP")

    # Short-lived engine created fresh every beat tick — no need for a pooled connection.
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    Session = async_sessionmaker(bind=engine, expire_on_commit=False)

    active_keys: set[str] = set()
    try:
        async with Session() as db:
            for model in (User, Chat):
                urls = (
                    (await db.execute(select(model.avatar_url).where(model.avatar_url.is_not(None))))
                    .scalars()
                    .all()
                )
                for url in urls:
                    if url:
                        active_keys.add(url.split("/")[-1])
    finally:
        await engine.dispose()

    print(f"MINIO GARBAGE COLLECTOR: FOUND {len(active_keys)} ACTIVE AVATAR KEYS")

    deleted_count = await _sweep_bucket(settings.MINIO_AVATAR_BUCKET, active_keys)

    print(f"MINIO GARBAGE COLLECTOR: FINISHED AVATAR BUCKET. DELETED {deleted_count} ORPHANS")


async def cleanup_minio_sticker_orphans():
    """Sweep the sticker bucket for objects no longer referenced by any `Sticker` row.

    A sticker image uploaded via `POST /files/upload?category=sticker` that is never followed by
    a successful `POST /packs/{pack_id}/stickers` call (abandoned upload, failed request, user
    navigates away mid-creation) has no deletion path otherwise — unlike a sticker that *did* get
    attached to a pack and later explicitly deleted, which `sticker_pack_service`/`sticker_service`
    already deletes synchronously. This sweep is the safety net for the former, mirroring the
    avatar sweep above.
    """
    print("MINIO GARBAGE COLLECTOR: START STICKER CLEANUP")

    # Short-lived engine created fresh every beat tick — no need for a pooled connection.
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    Session = async_sessionmaker(bind=engine, expire_on_commit=False)

    active_keys: set[str] = set()
    try:
        async with Session() as db:
            urls = (
                (await db.execute(select(Sticker.image_url).where(Sticker.image_url.is_not(None))))
                .scalars()
                .all()
            )
            for url in urls:
                if url:
                    active_keys.add(url.split("/")[-1])
    finally:
        await engine.dispose()

    print(f"MINIO GARBAGE COLLECTOR: FOUND {len(active_keys)} ACTIVE STICKER KEYS")

    deleted_count = await _sweep_bucket(settings.MINIO_STICKER_BUCKET, active_keys)

    print(f"MINIO GARBAGE COLLECTOR: FINISHED STICKER BUCKET. DELETED {deleted_count} ORPHANS")


@shared_task
def cleanup_minio_orphans_task():
    asyncio.run(cleanup_minio_orphans())
    asyncio.run(cleanup_minio_avatar_orphans())
    asyncio.run(cleanup_minio_sticker_orphans())
