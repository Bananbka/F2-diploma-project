"""The chats domain: creation, participant RBAC, the chat list, and lifecycle.

Chat creation, participant management and the chat list were previously exercised only
incidentally, as setup for other suites. `chat_services.role_rank` in particular deserves direct
coverage: it is the reason an admin cannot remove an owner, and it is the thing every one of
add/remove/change-role gates on.
"""

from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"


async def _private_chat(client, peer_id) -> dict:
    r = await client.post("/chats/private", json={"target_user_id": str(peer_id)})
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def _group(client, participant_ids, title="Group") -> dict:
    r = await client.post(
        "/chats/group",
        json={
            "title": title,
            "description": "d",
            "participant_ids": [str(p) for p in participant_ids],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def _channel(client, subscriber_ids, title="Channel") -> dict:
    r = await client.post(
        "/chats/channel",
        json={
            "title": title,
            "description": "d",
            "subscriber_ids": [str(p) for p in subscriber_ids],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


# --------------------------------------------------------------------------------------------
# Creation
# --------------------------------------------------------------------------------------------


async def test_private_chat_creation_is_idempotent_per_pair():
    """The same pair opening a chat twice must get back the same chat, not a duplicate."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        first = await _private_chat(alice, bob_id)
        second = await _private_chat(alice, bob_id)
        assert first["id"] == second["id"]

        # Either direction resolves to the same chat.
        third = await _private_chat(bob, alice_id)
        assert third["id"] == first["id"]

        assert first["chat_type"] == "private"
        assert {p["user_id"] for p in first["participants"]} == {str(alice_id), str(bob_id)}
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_private_chat_with_yourself_is_rejected():
    alice, alice_id = await _register_user()
    try:
        r = await alice.post("/chats/private", json={"target_user_id": str(alice_id)})
        assert r.status_code == 400, r.text
    finally:
        await alice.aclose()


async def test_group_chat_creation():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id, carol_id], title="Trio")
        assert chat["chat_type"] == "group"
        assert chat["title"] == "Trio"

        roles = {p["user_id"]: p["role"] for p in chat["participants"]}
        assert roles[str(alice_id)] == "owner"
        assert roles[str(bob_id)] == "member"
        assert roles[str(carol_id)] == "member"
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_channel_creation():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _channel(alice, [bob_id], title="Announcements")
        assert chat["chat_type"] == "channel"

        roles = {p["user_id"]: p["role"] for p in chat["participants"]}
        assert roles[str(alice_id)] == "owner"
        assert roles[str(bob_id)] == "member"
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------------------------
# Participant RBAC — chat_services.role_rank
# --------------------------------------------------------------------------------------------


async def test_admin_cannot_remove_an_owner():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id, carol_id])
        chat_id = chat["id"]

        # Promote bob to admin.
        r = await alice.post(
            f"/chats/{chat_id}/change-role",
            json={"user_id": str(bob_id), "role": "admin"},
        )
        assert r.status_code == 200, r.text

        # An admin outranks nobody at or above them — the owner is above.
        r = await bob.post(
            f"/chats/{chat_id}/delete-participants", json={"user_ids": [str(alice_id)]}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_owner_can_remove_an_admin():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id])
        chat_id = chat["id"]

        r = await alice.post(
            f"/chats/{chat_id}/change-role",
            json={"user_id": str(bob_id), "role": "admin"},
        )
        assert r.status_code == 200, r.text

        r = await alice.post(
            f"/chats/{chat_id}/delete-participants", json={"user_ids": [str(bob_id)]}
        )
        assert r.status_code == 200, r.text
        assert str(bob_id) not in {p["user_id"] for p in r.json()["data"]["participants"]}
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_plain_member_cannot_remove_anyone():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id, carol_id])
        chat_id = chat["id"]

        # bob, a plain member, tries to remove carol, also a plain member.
        r = await bob.post(
            f"/chats/{chat_id}/delete-participants", json={"user_ids": [str(carol_id)]}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_admin_can_add_participants_but_member_cannot():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    dave, dave_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id, carol_id])
        chat_id = chat["id"]

        r = await alice.post(
            f"/chats/{chat_id}/change-role",
            json={"user_id": str(bob_id), "role": "admin"},
        )
        assert r.status_code == 200, r.text

        r = await bob.post(
            f"/chats/{chat_id}/add-participants", json={"user_ids": [str(dave_id)]}
        )
        assert r.status_code == 200, r.text
        assert str(dave_id) in {p["user_id"] for p in r.json()["data"]["participants"]}

        r = await carol.post(
            f"/chats/{chat_id}/add-participants", json={"user_ids": [str(dave_id)]}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()
        await dave.aclose()


async def test_cannot_remove_a_participant_of_equal_role():
    """Two admins: neither outranks the other, so neither can remove the other."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id, carol_id])
        chat_id = chat["id"]

        for target in (bob_id, carol_id):
            r = await alice.post(
                f"/chats/{chat_id}/change-role",
                json={"user_id": str(target), "role": "admin"},
            )
            assert r.status_code == 200, r.text

        r = await bob.post(
            f"/chats/{chat_id}/delete-participants", json={"user_ids": [str(carol_id)]}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_rbac_endpoints_reject_private_chats():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _private_chat(alice, bob_id)
        chat_id = chat["id"]

        r = await alice.post(
            f"/chats/{chat_id}/add-participants", json={"user_ids": [str(bob_id)]}
        )
        assert r.status_code == 400, r.text

        r = await alice.post(
            f"/chats/{chat_id}/delete-participants", json={"user_ids": [str(bob_id)]}
        )
        assert r.status_code == 400, r.text

        r = await alice.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 400, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_cannot_grant_owner_via_change_role():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id])
        chat_id = chat["id"]

        r = await alice.post(
            f"/chats/{chat_id}/change-role",
            json={"user_id": str(bob_id), "role": "owner"},
        )
        assert r.status_code == 400, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------------------------
# Chat list: ordering, enrichment, private-chat de-duplication
# --------------------------------------------------------------------------------------------


async def test_chat_list_orders_most_recently_active_first():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        first = await _group(alice, [bob_id], title="First")
        second = await _group(alice, [carol_id], title="Second")

        # Sending touches the chat, so it should jump to the top of the list.
        r = await alice.post(
            "/messages/",
            json={"chat_id": first["id"], "encrypted_content": "hi"},
        )
        assert r.status_code == 201, r.text

        r = await alice.get("/chats/")
        assert r.status_code == 200, r.text
        titles = [c["title"] for c in r.json()["data"]]
        assert titles.index("First") < titles.index("Second")

        # Now touch the second one and confirm the order flips.
        r = await alice.post(
            "/messages/",
            json={"chat_id": second["id"], "encrypted_content": "hi"},
        )
        assert r.status_code == 201, r.text

        r = await alice.get("/chats/")
        titles = [c["title"] for c in r.json()["data"]]
        assert titles.index("Second") < titles.index("First")
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_chat_list_reports_unread_count_and_last_message():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id])

        r = await alice.post(
            "/messages/", json={"chat_id": chat["id"], "encrypted_content": "first"}
        )
        assert r.status_code == 201, r.text
        r = await alice.post(
            "/messages/", json={"chat_id": chat["id"], "encrypted_content": "second"}
        )
        assert r.status_code == 201, r.text

        r = await bob.get("/chats/")
        assert r.status_code == 200, r.text
        entry = next(c for c in r.json()["data"] if c["id"] == chat["id"])
        assert entry["unread_count"] == 2
        assert entry["last_message"]["encrypted_content"] == "second"

        # Alice sent both, so from her side they are not unread.
        r = await alice.get("/chats/")
        entry = next(c for c in r.json()["data"] if c["id"] == chat["id"])
        assert entry["unread_count"] == 0
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_chat_list_does_not_duplicate_groups():
    """A regression guard: the counterpart join used to be unrestricted to PRIVATE chats, so a
    group of N members produced N-1 rows for the same chat."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id, carol_id])

        r = await alice.get("/chats/")
        assert r.status_code == 200, r.text
        matches = [c for c in r.json()["data"] if c["id"] == chat["id"]]
        assert len(matches) == 1
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_chat_list_uses_the_contact_alias_for_a_private_chat_title():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        await _private_chat(alice, bob_id)

        r = await alice.post(
            "/contact/", json={"target_user_id": str(bob_id), "alias": "Bobby"}
        )
        assert r.status_code == 200, r.text

        r = await alice.get("/chats/")
        entry = next(
            c for c in r.json()["data"] if c["chat_type"] == "private"
        )
        assert entry["title"] == "Bobby"
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------------------------
# Ownership transfer / deletion
# --------------------------------------------------------------------------------------------


async def test_owner_cannot_leave_but_can_transfer_then_leave():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id])
        chat_id = chat["id"]

        r = await alice.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "OWNER_CANNOT_LEAVE"

        r = await alice.post(
            f"/chats/{chat_id}/transfer-ownership", json={"user_id": str(bob_id)}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["role"] == "owner"

        # Now alice is a plain admin and can leave.
        r = await alice.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 200, r.text

        r = await bob.get(f"/chats/{chat_id}")
        assert r.status_code == 200, r.text
        assert str(alice_id) not in {p["user_id"] for p in r.json()["data"]["participants"]}
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_only_the_owner_can_transfer_ownership():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id, carol_id])
        chat_id = chat["id"]

        r = await bob.post(
            f"/chats/{chat_id}/transfer-ownership", json={"user_id": str(carol_id)}
        )
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_private_chat_has_no_owner_to_transfer_or_delete():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _private_chat(alice, bob_id)
        chat_id = chat["id"]

        # No participant of a private chat is ever OWNER, so `transfer_ownership`'s role check —
        # which runs before its PRIVATE-chat check — rejects this as 403 rather than reaching the
        # 400 `INVALID_CHAT_TYPE` branch. Either way the operation is refused; this pins which one.
        r = await alice.post(
            f"/chats/{chat_id}/transfer-ownership", json={"user_id": str(bob_id)}
        )
        assert r.status_code == 403, r.text

        # `delete_chat` checks chat type before role, so a private chat is rejected as 400
        # regardless of who calls it.
        r = await alice.delete(f"/chats/{chat_id}")
        assert r.status_code == 400, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_owner_can_delete_the_chat_and_members_lose_access():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id])
        chat_id = chat["id"]

        r = await alice.delete(f"/chats/{chat_id}")
        assert r.status_code == 200, r.text

        r = await bob.get(f"/chats/{chat_id}")
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_only_the_owner_can_delete_the_chat():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat = await _group(alice, [bob_id])
        chat_id = chat["id"]

        r = await bob.delete(f"/chats/{chat_id}")
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
