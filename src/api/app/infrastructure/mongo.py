from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import settings


class MongoClient:
    client: AsyncIOMotorClient = None
    db = None


mongo_client = MongoClient()


async def connect_to_mongo():
    mongo_client.client = AsyncIOMotorClient(
        settings.MONGO_URL, uuidRepresentation="standard"
    )
    mongo_client.db = mongo_client.client[settings.MONGO_DB_NAME]
    print("Connected to MongoDB via Motor (Pure).")

    await ensure_indexes()


async def ensure_indexes():
    """Create the indexes the message read paths depend on. create_index is idempotent."""
    messages = mongo_client.db["messages"]

    # get_chat_messages (find by chat_id, sort _id desc) and the chat-list aggregation.
    await messages.create_index([("chat_id", 1), ("_id", -1)], name="ix_chat_id_id")

    # mark_messages_as_read's update_many predicate.
    await messages.create_index(
        [("chat_id", 1), ("sender_id", 1), ("is_read", 1)], name="ix_chat_sender_read"
    )

    # delete_message checks whether a blob is still referenced before reaping it from MinIO.
    await messages.create_index(
        [("attachments.url", 1)], name="ix_attachment_url", sparse=True
    )

    # _authorize_attachments asks whether an object is already referenced by a message in any of
    # the sender's chats, which is what allows forwarding without allowing replay.
    await messages.create_index(
        [("chat_id", 1), ("attachments.url", 1)],
        name="ix_chat_attachment_url",
        sparse=True,
    )

    audit_log = mongo_client.db["security_audit"]

    # The two ways an audit log is ever read: everything about one account, and everything in a
    # window. Both are investigation-time queries, so they only need to be possible, not fast.
    await audit_log.create_index(
        [("user_id", 1), ("created_at", -1)], name="ix_audit_user_time"
    )
    await audit_log.create_index([("created_at", -1)], name="ix_audit_time")
    await audit_log.create_index(
        [("event", 1), ("created_at", -1)], name="ix_audit_event_time"
    )

    print("MongoDB indexes ensured.")


async def close_mongo_connection():
    if mongo_client.client:
        mongo_client.client.close()
    print("MongoDB connection closed.")


def get_mongo_db():
    return mongo_client.db
