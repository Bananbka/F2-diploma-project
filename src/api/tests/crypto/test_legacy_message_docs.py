"""Old Mongo documents may still carry the removed `is_read` key; they must load and serialise."""

import datetime
import uuid

from bson import ObjectId

from app.domains.messages.schemas.messages_schemas import MessageDocument, MessageResponse


def _legacy_doc() -> dict:
    return {
        "_id": str(ObjectId()),
        "chat_id": uuid.uuid4(),
        "sender_id": uuid.uuid4(),
        "encrypted_content": "legacy",
        "is_read": True,
        "created_at": datetime.datetime.now(datetime.timezone.utc),
    }


def test_message_response_ignores_legacy_is_read():
    resp = MessageResponse.model_validate(_legacy_doc())
    assert not hasattr(resp, "is_read")
    assert "is_read" not in resp.model_dump()


def test_message_document_ignores_legacy_is_read():
    doc = _legacy_doc()
    doc.pop("_id")
    parsed = MessageDocument.model_validate(doc)
    assert not hasattr(parsed, "is_read")
