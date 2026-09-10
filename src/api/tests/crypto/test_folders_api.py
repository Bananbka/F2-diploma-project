"""Chat folders.

Folders are the least security-sensitive thing in the app, which is exactly why they were never
tested — and also why the two sharp edges here are easy to reintroduce. `PATCH` replaces
`chat_ids` wholesale rather than merging, and both endpoints must refuse a chat the caller is not
in, since a folder is otherwise a way to assert an association with a conversation you cannot see.
"""

import uuid

import httpx

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"


async def _folder(client, title="Work", chat_ids=None) -> dict:
    r = await client.post(
        "/chat-folder/",
        json={"title": title, "chat_ids": [str(c) for c in (chat_ids or [])]},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def test_folder_round_trip():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        folder = await _folder(alice, "Work", [chat_id])
        assert folder["title"] == "Work"
        assert [i["chat_id"] for i in folder["items"]] == [str(chat_id)]

        r = await alice.get(f"/chat-folder/{folder['id']}")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["title"] == "Work"

        r = await alice.get("/chat-folder/")
        assert r.status_code == 200, r.text
        assert folder["id"] in [f["id"] for f in r.json()["data"]]

        r = await alice.delete(f"/chat-folder/{folder['id']}")
        assert r.status_code == 200, r.text

        r = await alice.get(f"/chat-folder/{folder['id']}")
        assert r.status_code == 404, "a deleted folder must not still resolve"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_patch_replaces_chat_ids_wholesale():
    """Documented behaviour, and the one most likely to be misused.

    A caller who sends a delta expecting a merge empties the folder instead. Pinning it here means
    a future change to merge semantics has to be deliberate rather than accidental.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        first = await _group_with(alice, bob_id, title="First")
        second = await _group_with(alice, bob_id, title="Second")

        folder = await _folder(alice, "Both", [first, second])
        assert len(folder["items"]) == 2

        r = await alice.patch(
            f"/chat-folder/{folder['id']}", json={"chat_ids": [str(first)]}
        )
        assert r.status_code == 200, r.text
        assert [i["chat_id"] for i in r.json()["data"]["items"]] == [str(first)]

        # Title-only update must leave membership alone.
        r = await alice.patch(f"/chat-folder/{folder['id']}", json={"title": "Renamed"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["title"] == "Renamed"
        assert len(r.json()["data"]["items"]) == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_folder_cannot_reference_a_chat_you_are_not_in():
    """Both on create and on update — a folder must not assert an association you cannot see."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await mallory.post(
            "/chat-folder/", json={"title": "Nosy", "chat_ids": [str(chat_id)]}
        )
        assert r.status_code == 403, r.text

        own = await _folder(mallory, "Mine", [])
        r = await mallory.patch(
            f"/chat-folder/{own['id']}", json={"chat_ids": [str(chat_id)]}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_folders_are_private_to_their_owner():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        folder = await _folder(alice, "Private", [])

        r = await bob.get(f"/chat-folder/{folder['id']}")
        assert r.status_code == 404, "another user's folder must not be readable"

        r = await bob.patch(f"/chat-folder/{folder['id']}", json={"title": "Hijacked"})
        assert r.status_code == 404, r.text

        r = await bob.delete(f"/chat-folder/{folder['id']}")
        assert r.status_code == 404, r.text

        # Still intact and still Alice's.
        r = await alice.get(f"/chat-folder/{folder['id']}")
        assert r.json()["data"]["title"] == "Private"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_duplicate_chat_ids_are_accepted_rather_than_read_as_a_permission_failure():
    """A repeated id used to make the count check fail and surface as 403.

    The count query returns one row per chat however many times it is named, so comparing it
    against the raw list length rejected a request the user was fully entitled to make.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(
            "/chat-folder/",
            json={"title": "Dupes", "chat_ids": [str(chat_id), str(chat_id)]},
        )
        assert r.status_code == 200, r.text
        assert len(r.json()["data"]["items"]) == 1, "stored once, not twice"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_unknown_folder_is_a_404_not_a_crash():
    alice, alice_id = await _register_user()

    try:
        r = await alice.get(f"/chat-folder/{uuid.uuid4()}")
        assert r.status_code == 404, r.text

        r = await alice.delete(f"/chat-folder/{uuid.uuid4()}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()


async def test_folders_require_authentication():
    async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as anon:
        r = await anon.get("/chat-folder/")
        assert r.status_code == 401, r.text
