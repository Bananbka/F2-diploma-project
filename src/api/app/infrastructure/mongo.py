from motor.motor_asyncio import AsyncIOMotorClient
from app.core.config import settings


class MongoClient:
    client: AsyncIOMotorClient = None
    db = None


mongo_client = MongoClient()


async def connect_to_mongo():
    mongo_client.client = AsyncIOMotorClient(settings.MONGO_URL, uuidRepresentation="standard")
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

    print("MongoDB indexes ensured.")


async def close_mongo_connection():
    if mongo_client.client:
        mongo_client.client.close()
    print("MongoDB connection closed.")


def get_mongo_db():
    return mongo_client.db
