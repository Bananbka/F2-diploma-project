"""Attachment upload and download.

The most security-relevant of the three untested domains, because the attachment url on a message
is entirely client-supplied. Three separate checks have to hold together:

  * `Attachment.url` must name a single object key inside the message bucket, or a
    client-controlled value flows into MinIO deletion in `delete_message`.
  * A sender must own the object, or already be able to see it — otherwise naming a key you happen
    to know re-authorises you to fetch it through a chat of your own.
  * A reader must be in the chat *and* the object must be referenced by a message in that chat.
    Keys are a flat uuid namespace shared across every conversation, so membership alone is not
    enough.

The bytes themselves are ciphertext the server cannot read. These tests are about who may fetch
them, not what they mean.
"""

import uuid

import httpx

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"

# A one-pixel PNG. Avatars are magic-number checked, so a plausible header is required.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000a49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)


async def _upload(
    client, content=b"ciphertext-bytes", name="note.enc", category="message"
):
    return await client.post(
        "/files/upload",
        files={"file": (name, content, "application/octet-stream")},
        data={"category": category},
    )


async def _object_key(url: str) -> str:
    return url.rsplit("/", 1)[-1]


async def test_upload_and_download_through_a_chat():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await _upload(alice)
        assert r.status_code == 200, r.text
        attachment = r.json()["data"]
        assert attachment["size"] == len(b"ciphertext-bytes")

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 200, r.text

        key = await _object_key(attachment["url"])

        # Both members can read it.
        for client in (alice, bob):
            r = await client.get(f"/files/attachments/{chat_id}/{key}")
            assert r.status_code == 200, r.text
            assert r.content == b"ciphertext-bytes"
            # Never inline: the payload is attacker-supplied ciphertext.
            assert "attachment" in r.headers["content-disposition"]
            assert r.headers["x-content-type-options"] == "nosniff"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_download_requires_membership_and_a_reference_in_that_chat():
    """Either check alone is insufficient, so both are asserted separately."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        other_chat = await _group_with(alice, mallory_id, title="Other")

        r = await _upload(alice)
        attachment = r.json()["data"]
        key = await _object_key(attachment["url"])

        await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )

        # Not a member of that chat.
        r = await mallory.get(f"/files/attachments/{chat_id}/{key}")
        assert r.status_code == 403, r.text

        # A member of `other_chat`, but the object is not referenced there. Membership alone must
        # not open the whole flat key namespace.
        r = await mallory.get(f"/files/attachments/{other_chat}/{key}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_cannot_attach_a_file_you_neither_uploaded_nor_can_see():
    """The replay that made `download_attachment`'s two checks satisfiable by an outsider.

    Name a key you happen to know — one from a group you were removed from — in a message in your
    own chat, and both download checks then pass.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        private_chat = await _group_with(alice, bob_id)
        mallory_chat = await _group_with(mallory, alice_id, title="Mallory's")

        r = await _upload(alice)
        attachment = r.json()["data"]

        await alice.post(
            "/messages/",
            json={
                "chat_id": str(private_chat),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )

        # Mallory knows the key but neither uploaded it nor is in a chat that references it.
        r = await mallory.post(
            "/messages/",
            json={
                "chat_id": str(mallory_chat),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 403, r.text
        assert r.json()["error_code"] == "ATTACHMENT_FORBIDDEN"
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_forwarding_someone_elses_attachment_is_allowed():
    """The other side of the same rule. A forward is a re-send of the same object, so a member who
    can already see a file must be able to carry it into another chat of theirs."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        shared = await _group_with(alice, bob_id)
        bobs_other = await _group_with(bob, carol_id, title="Bob and Carol")

        r = await _upload(alice)
        attachment = r.json()["data"]
        await alice.post(
            "/messages/",
            json={
                "chat_id": str(shared),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )

        # Bob did not upload it, but he can see it, so he may forward it.
        r = await bob.post(
            "/messages/",
            json={
                "chat_id": str(bobs_other),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_attachment_url_must_name_a_single_key_in_the_message_bucket():
    """Without this the value flows into MinIO deletion in `delete_message`."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        for url in (
            "https://evil.example/steal.enc",
            "http://minio:9000/user-avatars/someone.png",
            "http://minio:9000/messages-attachments/nested/key.enc",
        ):
            r = await alice.post(
                "/messages/",
                json={
                    "chat_id": str(chat_id),
                    "encrypted_content": "x",
                    "attachments": [
                        {
                            "url": url,
                            "name": "n",
                            "size": 1,
                            "content_type": "application/octet-stream",
                        }
                    ],
                },
            )
            assert r.status_code == 422, f"{url} must be rejected: {r.text}"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_avatar_uploads_are_restricted_to_real_images():
    """The avatar bucket is public-read and serves the client's declared content type, so anything
    outside the allowlist turns it into arbitrary hosting on the deployment's own domain."""
    alice, alice_id = await _register_user()

    try:
        # Declared type outside the allowlist.
        r = await alice.post(
            "/files/upload",
            files={"file": ("x.html", b"<script>alert(1)</script>", "text/html")},
            data={"category": "avatar"},
        )
        assert r.status_code == 415, r.text

        # Allowed type, but the bytes are not an image — the declared type is client-supplied.
        r = await alice.post(
            "/files/upload",
            files={"file": ("x.png", b"<script>alert(1)</script>", "image/png")},
            data={"category": "avatar"},
        )
        assert r.status_code == 415, r.text

        r = await alice.post(
            "/files/upload",
            files={"file": ("ok.png", PNG, "image/png")},
            data={"category": "avatar"},
        )
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()


async def test_empty_upload_is_rejected():
    alice, alice_id = await _register_user()

    try:
        r = await _upload(alice, content=b"")
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "EMPTY_FILE"
    finally:
        await alice.aclose()


async def test_unknown_attachment_key_is_not_found_rather_than_a_crash():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.get(f"/files/attachments/{chat_id}/{uuid.uuid4()}.enc")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_files_require_authentication():
    async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as anon:
        r = await anon.post(
            "/files/upload",
            files={"file": ("a.enc", b"x", "application/octet-stream")},
        )
        assert r.status_code == 401, r.text
