import asyncio
from datetime import datetime, timezone, timedelta

from celery import shared_task
from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import settings
from app.infrastructure.minio import minio_manager


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

    print(f"MINIO GARBAGE COLLECTOR: FOUND {len(active_keys)} ACTIVE KEYS")

    bucket_name = settings.MINIO_MESSAGE_BUCKET

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

                if age > timedelta(hours=24):
                    if key not in active_keys:
                        print(f"MINIO GARBAGE COLLECTOR: DELETING ORPHAN {key}")
                        await client.delete_object(Bucket=bucket_name, Key=key)
                        deleted_count += 1

    mongo_client.close()
    print(f"MINIO GARBAGE COLLECTOR: FINISHED. DELETED {deleted_count} ORPHANS")


@shared_task
def cleanup_minio_orphans_task():
    asyncio.run(cleanup_minio_orphans())
