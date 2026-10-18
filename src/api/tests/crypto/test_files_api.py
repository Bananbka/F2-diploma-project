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

from app.core.config import settings
from app.domains.crypto.reference.ratchet import SenderChain

from tests.crypto.test_channel_api import _channel_with, _post
from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_identity_api import _register_user, rate_limit_bypass_headers
from tests.crypto.test_message_envelope_api import _encrypted_private_chat
from tests.crypto.test_rotation_api import _seal

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
    async with httpx.AsyncClient(base_url=BASE, timeout=30.0, headers=rate_limit_bypass_headers()) as anon:
        r = await anon.post(
            "/files/upload",
            files={"file": ("a.enc", b"x", "application/octet-stream")},
        )
        assert r.status_code == 401, r.text


async def test_only_the_sender_may_delete_their_message_and_its_attachment():
    """`get_and_validate_message` checks `sender_id`, not chat membership or role — a fellow member,
    even in a group, has no delete rights over someone else's message."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await _upload(alice)
        attachment = r.json()["data"]
        key = await _object_key(attachment["url"])

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        # Bob is a member of the same chat but did not send the message.
        r = await bob.delete(f"/messages/{message_id}")
        assert r.status_code == 403, r.text

        # The message and its attachment must still be there.
        r = await alice.get(f"/files/attachments/{chat_id}/{key}")
        assert r.status_code == 200, r.text

        r = await alice.delete(f"/messages/{message_id}")
        assert r.status_code == 200, r.text

        # Gone, and no longer downloadable through the chat that used to reference it.
        r = await alice.get(f"/files/attachments/{chat_id}/{key}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_deleting_one_forward_does_not_reap_a_still_referenced_attachment():
    """`delete_message` only reaps the MinIO blob once no surviving message references its url.

    Forward the same attachment into a second chat, delete the original, and the object must
    still be fetchable through the chat that still names it — proving the still-referenced guard
    actually runs, not just that a single, unshared attachment can be deleted.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        shared = await _group_with(alice, bob_id)
        bobs_other = await _group_with(bob, carol_id, title="Bob and Carol")

        r = await _upload(alice)
        attachment = r.json()["data"]
        key = await _object_key(attachment["url"])

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(shared),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 200, r.text
        original_id = r.json()["data"]["_id"]

        r = await bob.post(
            "/messages/",
            json={
                "chat_id": str(bobs_other),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 200, r.text

        r = await alice.delete(f"/messages/{original_id}")
        assert r.status_code == 200, r.text

        # Still referenced by Bob's forward, so the blob must survive.
        r = await bob.get(f"/files/attachments/{bobs_other}/{key}")
        assert r.status_code == 200, r.text
        assert r.content == b"ciphertext-bytes"

        # But no longer reachable through the chat whose only reference was just deleted.
        r = await bob.get(f"/files/attachments/{shared}/{key}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_oversized_message_attachment_is_rejected():
    """`_read_bounded` enforces the 50MB message cap while streaming, not after buffering it all."""
    alice, alice_id = await _register_user()

    try:
        oversized = b"\x00" * (50 * 1024 * 1024 + 1)
        r = await _upload(alice, content=oversized)
        assert r.status_code == 413, r.text
        assert r.json()["error_code"] == "FILE_SIZE_TOO_LARGE"
    finally:
        await alice.aclose()


async def test_editing_text_only_leaves_attachments_untouched():
    """The common case: `attachments` omitted entirely from the edit body must not touch the
    existing list — distinct from sending an explicit `[]`."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await _upload(alice)
        attachment = r.json()["data"]

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        r = await alice.put(
            f"/messages/{message_id}", json={"encrypted_content": "edited text"}
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["is_edited"] is True
        assert len(data["attachments"]) == 1
        assert data["attachments"][0]["url"] == attachment["url"]
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_editing_to_add_an_owned_attachment_succeeds():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(
            "/messages/", json={"chat_id": str(chat_id), "encrypted_content": "x"}
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]
        assert r.json()["data"]["attachments"] is None

        r = await _upload(alice)
        attachment = r.json()["data"]

        r = await alice.put(
            f"/messages/{message_id}",
            json={"encrypted_content": "x", "attachments": [attachment]},
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert len(data["attachments"]) == 1
        assert data["attachments"][0]["url"] == attachment["url"]
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_editing_to_add_an_unowned_unseen_attachment_is_rejected():
    """Same `_authorize_attachments` gate the send path uses: swapping in an attachment the
    editor neither uploaded nor can currently see must be rejected on edit exactly like it would
    be on send."""
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

        r = await mallory.post(
            "/messages/", json={"chat_id": str(mallory_chat), "encrypted_content": "x"}
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        # Mallory knows the key but neither uploaded it nor is in a chat that references it.
        r = await mallory.put(
            f"/messages/{message_id}",
            json={"encrypted_content": "x", "attachments": [attachment]},
        )
        assert r.status_code == 403, r.text
        assert r.json()["error_code"] == "ATTACHMENT_FORBIDDEN"
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_editing_to_remove_all_attachments_with_explicit_empty_list():
    """`attachments: []` is a legitimate "remove everything" edit, distinct from omitting the
    field (which must leave the list untouched — see the companion test above)."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await _upload(alice)
        attachment = r.json()["data"]

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        r = await alice.put(
            f"/messages/{message_id}",
            json={"encrypted_content": "x", "attachments": []},
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["attachments"] == []
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_editing_a_legacy_plaintext_message_attachment_still_goes_through_authorization():
    """`_authorize_attachments` must gate an edit regardless of `content_format` — a legacy,
    unencrypted group message is not a special path that skips it."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)  # legacy_plaintext: no crypto enabled

        mallory_chat = await _group_with(mallory, bob_id, title="Mallory's")
        r = await _upload(mallory)
        attachment = r.json()["data"]
        await mallory.post(
            "/messages/",
            json={
                "chat_id": str(mallory_chat),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )

        r = await alice.post(
            "/messages/", json={"chat_id": str(chat_id), "encrypted_content": "x"}
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]
        assert r.json()["data"]["content_format"] == "legacy_plaintext"

        # Alice neither uploaded Mallory's attachment nor can see it from any chat of her own.
        r = await alice.put(
            f"/messages/{message_id}",
            json={"encrypted_content": "x", "attachments": [attachment]},
        )
        assert r.status_code == 403, r.text
        assert r.json()["error_code"] == "ATTACHMENT_FORBIDDEN"
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_editing_a_channel_post_attachments_is_rejected_as_not_editable():
    """The channel-post-not-editable check must run before attachment authorization: an edit
    attempt on a channel post gets `CHANNEL_POST_NOT_EDITABLE`, not `ATTACHMENT_FORBIDDEN`, even
    when the attachment in the request would also have failed authorization on its own."""
    owner, owner_id = await _register_user()
    subscriber, subscriber_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        _, owner_keys = await _publish_identity(owner, owner_id)
        chat_id = await _channel_with(owner, [subscriber_id])

        r = await owner.post(
            "/messages/",
            json={"chat_id": str(chat_id), "channel_post": _post(owner_keys, chat_id, owner_id)},
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        # An attachment Mallory owns and the owner cannot see — this would be ATTACHMENT_FORBIDDEN
        # if attachment authorization ran at all, which is exactly what must not happen here.
        mallory_chat = await _group_with(mallory, subscriber_id, title="Mallory's")
        r = await _upload(mallory)
        attachment = r.json()["data"]
        await mallory.post(
            "/messages/",
            json={
                "chat_id": str(mallory_chat),
                "encrypted_content": "x",
                "attachments": [attachment],
            },
        )

        r = await owner.put(
            f"/messages/{message_id}",
            json={"encrypted_content": "x", "attachments": [attachment]},
        )
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "CHANNEL_POST_NOT_EDITABLE"
    finally:
        await owner.aclose()
        await subscriber.aclose()
        await mallory.aclose()


async def test_rejected_edit_does_not_persist_a_smuggled_attachment_list():
    """A request rejected on `CHAIN_INDEX_REUSED` must not leave the attachments half of the same
    `$set` applied. Both must be rejected together, not validated-then-partially-written."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id, epoch, chain_key, skid, chain_identity = await _encrypted_private_chat(
            alice, alice_id, bob, bob_id
        )
        sender = SenderChain(chain_key)

        envelope = _seal(sender, chat_id, epoch, alice_id, skid, chain_identity, body=b"original")
        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]
        assert r.json()["data"]["attachments"] is None

        r = await _upload(alice)
        attachment = r.json()["data"]

        # Same envelope again (reused index 0) plus a legitimately-owned attachment list — the
        # reuse rejection must not let the attachments half through.
        r = await alice.put(
            f"/messages/{message_id}",
            json={"envelope": envelope, "attachments": [attachment]},
        )
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "CHAIN_INDEX_REUSED"

        r = await alice.get(f"/chats/{chat_id}/messages")
        assert r.status_code == 200, r.text
        fetched = r.json()["data"][0]
        assert fetched["_id"] == message_id
        assert fetched["attachments"] is None
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_oversized_avatar_is_rejected_at_the_lower_avatar_cap():
    alice, alice_id = await _register_user()

    try:
        oversized = PNG + b"\x00" * (5 * 1024 * 1024)
        r = await alice.post(
            "/files/upload",
            files={"file": ("big.png", oversized, "image/png")},
            data={"category": "avatar"},
        )
        assert r.status_code == 413, r.text
        assert r.json()["error_code"] == "FILE_SIZE_TOO_LARGE"
    finally:
        await alice.aclose()


async def test_avatar_and_sticker_uploads_use_the_public_base_url():
    """A public-bucket upload's returned url must be browser-reachable (MINIO_PUBLIC_URL), not the
    Docker-internal MINIO_URL — storing the internal hostname is exactly what made avatars and
    stickers render as alt-text instead of images."""
    alice, alice_id = await _register_user()

    try:
        for category, bucket in (
            ("avatar", settings.MINIO_AVATAR_BUCKET),
            ("sticker", settings.MINIO_STICKER_BUCKET),
        ):
            r = await alice.post(
                "/files/upload",
                files={"file": ("ok.png", PNG, "image/png")},
                data={"category": category},
            )
            assert r.status_code == 200, r.text
            url = r.json()["data"]["url"]
            assert url.startswith(f"{settings.MINIO_PUBLIC_URL}/{bucket}/"), url
            assert settings.MINIO_URL not in url
    finally:
        await alice.aclose()


async def test_message_attachment_upload_still_uses_the_internal_base_url():
    """Message-bucket attachments are never rendered as a raw `<img src>` — the client always
    fetches them through the authenticated download proxy — so their url must stay anchored to the
    internal MINIO_URL, not the public one."""
    alice, alice_id = await _register_user()

    try:
        r = await _upload(alice)
        assert r.status_code == 200, r.text
        url = r.json()["data"]["url"]
        assert url.startswith(f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/"), url
    finally:
        await alice.aclose()


async def test_batch_attachment_download_requires_membership():
    alice, alice_id = await _register_user()
    mallory, mallory_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await mallory.post(
            "/files/attachments/batch",
            json={"chat_id": str(chat_id), "object_keys": ["whatever.enc"]},
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await mallory.aclose()
        await bob.aclose()


async def test_batch_attachment_download_mixed_statuses():
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

        # A second, never-referenced key and a key only referenced in a *different* chat of
        # Alice's own, alongside the one real key.
        unknown_key = f"{uuid.uuid4()}.enc"

        other_r = await _upload(alice)
        other_attachment = other_r.json()["data"]
        other_key = await _object_key(other_attachment["url"])
        await alice.post(
            "/messages/",
            json={
                "chat_id": str(other_chat),
                "encrypted_content": "x",
                "attachments": [other_attachment],
            },
        )

        r = await alice.post(
            "/files/attachments/batch",
            json={
                "chat_id": str(chat_id),
                "object_keys": [key, unknown_key, other_key],
            },
        )
        assert r.status_code == 200, r.text
        by_key = {item["object_key"]: item for item in r.json()["data"]}

        assert by_key[key]["status"] == "ok"
        assert by_key[key]["content_base64"] is not None
        import base64

        assert base64.b64decode(by_key[key]["content_base64"]) == b"ciphertext-bytes"

        assert by_key[unknown_key]["status"] == "not_found"
        # Referenced only in `other_chat`, not `chat_id`, so must not be served through this chat.
        assert by_key[other_key]["status"] == "not_found"
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_batch_attachment_download_gone_for_a_reaped_object():
    """A key that *is* referenced by a message in this chat but whose object no longer exists in
    the store must report `gone`, not a 500 — mirroring the single-endpoint's ATTACHMENT_GONE."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

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

        from app.infrastructure.minio import minio_manager

        await minio_manager.delete_file(attachment["url"], settings.MINIO_MESSAGE_BUCKET)

        r = await alice.post(
            "/files/attachments/batch",
            json={"chat_id": str(chat_id), "object_keys": [key]},
        )
        assert r.status_code == 200, r.text
        result = r.json()["data"][0]
        assert result["status"] == "gone"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_batch_attachment_download_enforces_the_key_cap():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        too_many = [f"{uuid.uuid4()}.enc" for _ in range(51)]
        r = await alice.post(
            "/files/attachments/batch",
            json={"chat_id": str(chat_id), "object_keys": too_many},
        )
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
