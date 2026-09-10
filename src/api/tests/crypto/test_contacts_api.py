"""Contacts.

Small surface, but it carries more weight than it looks. A contact's `alias_name` overrides the
displayed name everywhere — including in a private chat's title — so the contact list is one of
the few id-keyed name sources the client has. It is also an upsert, which means `POST` doubles as
rename, and posting without an alias clears one.
"""

import uuid

import httpx

from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"


async def _username_of(client) -> str:
    r = await client.get("/profile/me")
    assert r.status_code == 200, r.text
    return r.json()["data"]["username"]


async def test_contact_round_trip():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        r = await alice.post(
            "/contact/", json={"target_user_id": str(bob_id), "alias": "Bobby"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["alias_name"] == "Bobby"
        assert r.json()["data"]["contact_id"] == str(bob_id)

        r = await alice.get("/contact/")
        assert r.status_code == 200, r.text
        assert [c["contact_id"] for c in r.json()["data"]] == [str(bob_id)]

        r = await alice.delete(f"/contact/{bob_id}")
        assert r.status_code == 200, r.text

        r = await alice.get("/contact/")
        assert r.json()["data"] == []
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_posting_again_renames_rather_than_duplicating():
    """POST is an upsert, so it doubles as rename — documented, and easy to regress into a 409."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        await alice.post(
            "/contact/", json={"target_user_id": str(bob_id), "alias": "First"}
        )
        r = await alice.post(
            "/contact/", json={"target_user_id": str(bob_id), "alias": "Second"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["alias_name"] == "Second"

        contacts = (await alice.get("/contact/")).json()["data"]
        assert len(contacts) == 1, "an upsert must not create a second row"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_posting_without_an_alias_clears_an_existing_one():
    """Also documented, also surprising: omitting `alias` is a clear, not a no-op."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        await alice.post(
            "/contact/", json={"target_user_id": str(bob_id), "alias": "Bobby"}
        )

        r = await alice.post("/contact/", json={"target_user_id": str(bob_id)})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["alias_name"] is None
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_contacts_are_private_to_their_owner():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        await alice.post(
            "/contact/", json={"target_user_id": str(bob_id), "alias": "Bobby"}
        )

        # Bob is *in* Alice's contacts and must still not see her list.
        assert (await bob.get("/contact/")).json()["data"] == []
        assert (await carol.get("/contact/")).json()["data"] == []

        # Nor delete from it. Scoped by owner in the statement, so this removes nothing.
        r = await bob.delete(f"/contact/{bob_id}")
        assert r.status_code == 404, r.text

        assert len((await alice.get("/contact/")).json()["data"]) == 1
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_contact_exposes_only_the_public_projection():
    """`ContactResponse.user` is the search projection, so a contact must not leak more than a
    search would — the same rule `/users/{query}` was violating."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        r = await alice.post(
            "/contact/", json={"target_user_id": str(bob_id), "alias": "Bobby"}
        )
        user = r.json()["data"]["user"]

        assert "email" not in user
        assert "phone_number" not in user
        assert user["id"] == str(bob_id)
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_cannot_add_yourself_or_a_stranger():
    alice, alice_id = await _register_user()

    try:
        r = await alice.post("/contact/", json={"target_user_id": str(alice_id)})
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "INVALID_CONTACT_ID"

        r = await alice.post("/contact/", json={"target_user_id": str(uuid.uuid4())})
        assert r.status_code == 404, r.text
        assert r.json()["error_code"] == "USER_NOT_FOUND"
    finally:
        await alice.aclose()


async def test_deleting_a_contact_that_is_not_there_is_a_404():
    alice, alice_id = await _register_user()

    try:
        r = await alice.delete(f"/contact/{uuid.uuid4()}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()


async def test_contacts_require_authentication():
    async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as anon:
        r = await anon.get("/contact/")
        assert r.status_code == 401, r.text
