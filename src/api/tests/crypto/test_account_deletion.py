"""`DELETE /profile` -- account deletion as a tombstone.

The decisions under test (docs/account-deletion-plan.md, sections 1 and 7): the `users` row stays
but holds no personal data; messages and public keys are never deleted, so other members can still
open and verify what the deleted account wrote; every encrypted chat re-keys; a group owner's role
passes on; private chats with a deleted peer become read-only.
"""
import asyncio
import contextlib
import uuid

import httpx
import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings as app_settings
from app.domains.crypto.reference.envelope import open_message
from app.domains.crypto.reference.grants import unwrap_chain_key, verify_distribution
from app.domains.crypto.reference.identity import verify_identity_binding
from app.domains.crypto.reference.primitives import b64u_decode
from app.domains.crypto.reference.ratchet import ReceiverChain, SenderChain

# Registers every model the in-process service calls below touch (see the note in
# tests/stickers/test_sticker_packs.py).
from app.domains.chats.models import ChatParticipant  # noqa: F401
from app.domains.users.models import User  # noqa: F401
from app.domains.chats.services import chat_services
from app.domains.users.services import account_deletion_service

from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_identity_api import BASE, _register_user, rate_limit_bypass_headers
from tests.crypto.test_message_envelope_api import _encrypted_private_chat
from tests.crypto.test_rotation_api import _publish_chain, _seal
from tests.stickers.test_sticker_packs import _create_pack

PASSWORD = "TestPassw0rd!"
SECRET = b"written before the author left"


@contextlib.asynccontextmanager
async def _session():
    engine = create_async_engine(app_settings.DATABASE_URL)
    try:
        async with async_sessionmaker(bind=engine, expire_on_commit=False)() as db:
            yield db
    finally:
        await engine.dispose()


async def _scalar(sql: str, **params):
    async with _session() as db:
        return (await db.execute(text(sql), params)).scalar()


async def _delete_account(client, password=PASSWORD):
    return await client.request("DELETE", "/profile", json={"password": password})


async def _me(client) -> dict:
    r = await client.get("/profile/me")
    assert r.status_code == 200, r.text
    return r.json()["data"]


# --------------------------------------------------------------------------- request handling


async def test_wrong_password_is_refused_and_changes_nothing():
    alice, alice_id = await _register_user()
    try:
        r = await _delete_account(alice, "not-the-password")
        assert r.status_code == 401, r.text
        assert r.json()["error_code"] == "INVALID_PASSWORD"

        assert (await _me(alice))["is_deleted"] is False
        assert await _scalar("SELECT deleted_at FROM users WHERE id = :u", u=alice_id) is None
    finally:
        await alice.aclose()


@pytest.mark.parametrize("body", [None, {}, {"password": PASSWORD, "extra": 1}])
async def test_body_is_required_and_strict(body):
    alice, alice_id = await _register_user()
    try:
        r = await alice.request("DELETE", "/profile", json=body) if body is not None else (
            await alice.request("DELETE", "/profile")
        )
        assert r.status_code == 422, r.text
        assert await _scalar("SELECT deleted_at FROM users WHERE id = :u", u=alice_id) is None
    finally:
        await alice.aclose()


async def test_unauthenticated_delete_is_refused():
    async with httpx.AsyncClient(base_url=BASE, headers=rate_limit_bypass_headers()) as anon:
        r = await anon.request("DELETE", "/profile", json={"password": PASSWORD})
        assert r.status_code == 401, r.text


async def test_password_guessing_is_rate_limited():
    alice, alice_id = await _register_user()
    try:
        statuses = [(await _delete_account(alice, "wrong-guess")).status_code for _ in range(10)]
        assert statuses[0] == 401
        assert 429 in statuses, "the delete endpoint must not be an unlimited password oracle"
        # Even the right password is refused while the window is exhausted.
        assert (await _delete_account(alice)).status_code == 429
    finally:
        await alice.aclose()


async def test_delete_with_body_works_through_the_gateway():
    """nginx must forward a request body on DELETE. Tried by service name first (inside the compose
    network) and then by the published port (from the host)."""
    alice, alice_id = await _register_user()
    try:
        r = None
        cookie_header = "; ".join(f"{c.name}={c.value}" for c in alice.cookies.jar)
        for base in ("http://gateway/api", "http://localhost:4200/api"):
            async with httpx.AsyncClient(
                base_url=base, headers={"Cookie": cookie_header}, timeout=30.0
            ) as via:
                try:
                    r = await via.request("DELETE", "/profile", json={"password": PASSWORD})
                    break
                except httpx.TransportError:
                    continue
        if r is None:
            pytest.skip("gateway is not reachable")

        assert r.status_code == 200, r.text
        assert await _scalar("SELECT deleted_at FROM users WHERE id = :u", u=alice_id) is not None
    finally:
        await alice.aclose()


# ---------------------------------------------------------------------------- the tombstone


async def test_deleted_account_is_anonymised_locked_out_and_its_names_are_free():
    alice, alice_id = await _register_user()
    try:
        before = await _me(alice)
        await _publish_identity(alice, alice_id)

        r = await _delete_account(alice)
        assert r.status_code == 200, r.text

        async with _session() as db:
            row = (await db.execute(
                text("SELECT username, email, phone_number, full_name, bio, avatar_url, is_active, "
                     "is_verified, deleted_at, encrypted_private_key, public_key "
                     "FROM users WHERE id = :u"),
                {"u": alice_id},
            )).one()

        assert before["username"] not in row.username
        assert before["email"] not in row.email
        assert before["phone_number"] != row.phone_number
        assert row.full_name == "Deleted user"
        assert row.bio is None and row.avatar_url is None
        assert row.is_active is False and row.is_verified is False
        assert row.deleted_at is not None
        assert row.encrypted_private_key == ""
        assert row.public_key, "the public key is public and stays"

        # Sessions die immediately.
        assert (await alice.get("/profile/me")).status_code in (401, 403)

        # The old credentials no longer work, and say nothing different from "wrong password".
        async with httpx.AsyncClient(base_url=BASE, headers=rate_limit_bypass_headers()) as anon:
            r = await anon.post(
                "/auth/login", json={"username": before["username"], "password": PASSWORD}
            )
            assert r.status_code == 401 and r.json()["error_code"] == "INVALID_CREDENTIALS"

            r = await anon.post(
                "/auth/login", json={"username": row.username, "password": PASSWORD}
            )
            assert r.status_code == 401 and r.json()["error_code"] == "INVALID_CREDENTIALS"

            # Neither the username nor the email is blocked by the tombstone.
            r = await anon.post("/auth/register", json={
                "full_name": "Reborn", "username": before["username"], "password": PASSWORD,
                "email": before["email"],
                "phone_number": f"+38067{uuid.uuid4().int % 10_000_000:07d}",
                "public_key": "legacy", "encrypted_private_key": "legacy",
            })
            assert r.status_code == 200, r.text
            assert r.json()["data"]["id"] != str(alice_id)
    finally:
        await alice.aclose()


async def test_key_material_is_revoked_but_public_keys_are_kept():
    alice, alice_id = await _register_user()
    try:
        device, bundle = await _publish_identity(alice, alice_id)
        await _delete_account(alice)

        async with _session() as db:
            key = (await db.execute(
                text("SELECT is_active, encrypted_private_bundle, identity_public_key, "
                     "identity_key_signature FROM user_identity_keys WHERE user_id = :u"),
                {"u": alice_id},
            )).one()
            device_row = (await db.execute(
                text("SELECT is_active, revoked_at FROM user_devices WHERE id = :d"), {"d": device}
            )).one()

        assert key.is_active is False
        assert key.encrypted_private_bundle == "", "the sealed private bundle must be destroyed"
        assert key.identity_public_key and key.identity_key_signature
        assert device_row.is_active is False and device_row.revoked_at is not None
    finally:
        await alice.aclose()


async def test_audit_event_is_recorded_without_personal_data():
    alice, alice_id = await _register_user()
    mongo = AsyncIOMotorClient(app_settings.MONGO_URL, uuidRepresentation="standard")
    try:
        await _delete_account(alice)

        doc = await mongo[app_settings.MONGO_DB_NAME]["security_audit"].find_one(
            {"event": "account_deleted", "user_id": alice_id}
        )
        assert doc is not None
        assert doc.get("client_ip") is None
        assert set(doc["details"]) <= {
            "chats_left", "chats_deleted", "private_chats_frozen", "ownership_transfers",
        }
    finally:
        mongo.close()
        await alice.aclose()


async def test_second_delete_is_not_possible():
    alice, alice_id = await _register_user()
    try:
        assert (await _delete_account(alice)).status_code == 200
        assert (await _delete_account(alice)).status_code in (401, 403)
    finally:
        await alice.aclose()


# ------------------------------------------------------------------ what others keep seeing


async def test_other_members_still_open_and_verify_what_the_deleted_author_wrote():
    """The headline guarantee: A posts, A deletes the account, B still reads and verifies it."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        bob_device, bob_keys = await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 200, r.text
        epoch = r.json()["data"]["epoch"]

        chain_key, skid, chain_identity = await _publish_chain(
            alice, chat_id, epoch, alice_id, alice_device, alice_keys
        )
        envelope = _seal(SenderChain(chain_key), chat_id, epoch, alice_id, skid, chain_identity, SECRET)
        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 201, r.text

        before = (await bob.get(f"/crypto/chats/{chat_id}/keys")).json()["data"]
        assert len(before["distributions"]) == 1

        assert (await _delete_account(alice)).status_code == 200

        # --- the chat re-keyed: Alice left the member set ---------------------------------
        after = (await bob.get(f"/crypto/chats/{chat_id}/keys")).json()["data"]
        assert after["current_epoch"] == epoch + 1
        newest = max(after["epochs"], key=lambda e: e["epoch"])
        assert newest["reason"] == "member_removed" and newest["member_count"] == 1
        assert sum(1 for e in after["epochs"] if e["closed_at"] is None) == 1

        roster = (await bob.get(f"/crypto/chats/{chat_id}/roster")).json()["data"]
        assert [m["user_id"] for m in roster["members"]] == [str(bob_id)]

        # --- the sender key chain is byte-for-byte what it was ----------------------------
        assert len(after["distributions"]) == 1
        assert after["distributions"][0] == before["distributions"][0]
        dist = after["distributions"][0]

        # --- B can still verify the distribution against Alice's retained identity key -----
        r = await bob.post("/crypto/keys/batch", json={"user_ids": [str(alice_id)]})
        assert r.status_code == 200, r.text
        keys = [k for k in r.json()["data"] if k["device_id"] == dist["sender_device_id"]]
        assert len(keys) == 1
        alice_key = keys[0]
        assert alice_key["is_active"] is False, "a retained key must say it is not live"

        assert verify_identity_binding(
            uuid.UUID(alice_key["user_id"]), uuid.UUID(alice_key["device_id"]),
            b64u_decode(alice_key["identity_public_key"]),
            b64u_decode(alice_key["signing_public_key"]),
            b64u_decode(alice_key["identity_key_signature"]),
        )
        assert verify_distribution(
            identity_signing_public=b64u_decode(alice_key["signing_public_key"]),
            signature=b64u_decode(dist["signature"]),
            chat_id=chat_id, epoch=dist["epoch"],
            sender_key_id=uuid.UUID(dist["sender_key_id"]),
            chain_signing_public=b64u_decode(dist["signing_public_key"]),
            chain_start_index=dist["chain_start_index"],
        )

        # --- and decrypt, and check the per-message signature -------------------------------
        recovered, start = unwrap_chain_key(
            wrapped=dist["grant"]["wrapped_chain_key"],
            ephemeral_public=dist["grant"]["ephemeral_public_key"],
            recipient_private=bob_keys.identity_private,
            chat_id=chat_id, epoch=dist["epoch"],
            sender_key_id=uuid.UUID(dist["sender_key_id"]),
            sender_device_id=uuid.UUID(dist["sender_device_id"]),
            recipient_device_id=bob_device,
        )
        assert recovered == chain_key and start == 0

        fetched = (await bob.get(f"/chats/{chat_id}/messages")).json()["data"][0]
        assert fetched["sender_id"] == str(alice_id), "messages keep pointing at the tombstone"
        assert open_message(
            message_key=ReceiverChain(recovered).message_key_for(fetched["envelope"]["idx"])[0],
            envelope=fetched["envelope"], chat_id=chat_id, sender_id=alice_id,
            signing_public=b64u_decode(dist["signing_public_key"]),
        ) == SECRET
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_user_projections_show_a_neutral_deleted_user():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        former = await _me(alice)
        await _delete_account(alice)

        r = await bob.post("/users/batch", json={"user_ids": [str(alice_id), str(bob_id)]})
        assert r.status_code == 200, r.text
        by_id = {u["id"]: u for u in r.json()["data"]}

        gone = by_id[str(alice_id)]
        assert gone == {
            "id": str(alice_id), "full_name": "Deleted user", "username": "deleted",
            "avatar_url": None, "bio": None, "is_deleted": True,
        }
        assert by_id[str(bob_id)]["is_deleted"] is False

        # Neither lookup nor search can find the person who used to own the name.
        assert (await bob.get(f"/users/{former['username']}")).status_code == 404
        r = await bob.get("/users/search", params={"query": former["username"][:12]})
        assert all(u["id"] != str(alice_id) for u in r.json()["data"])
        r = await bob.get("/users/search", params={"query": "deleted_"})
        assert all(u["id"] != str(alice_id) for u in r.json()["data"])

        # A tombstone cannot be befriended or invited.
        r = await bob.post("/contact/", json={"target_user_id": str(alice_id)})
        assert r.status_code == 404
        r = await bob.post("/chats/group", json={
            "title": "G", "description": "d", "participant_ids": [str(alice_id)],
        })
        assert r.status_code == 400 and r.json()["error_code"] == "USER_DELETED"
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------- group ownership


async def _roles(chat_id) -> dict[uuid.UUID, str]:
    async with _session() as db:
        rows = (await db.execute(
            text("SELECT user_id, role FROM chat_participants WHERE chat_id = :c"), {"c": chat_id}
        )).all()
    return {r.user_id: r.role for r in rows}


async def test_ownership_passes_to_the_oldest_admin():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(f"/chats/{chat_id}/add-participants", json={"user_ids": [str(carol_id)]})
        assert r.status_code == 200, r.text
        r = await alice.post(
            f"/chats/{chat_id}/change-role", json={"user_id": str(carol_id), "role": "admin"}
        )
        assert r.status_code == 200, r.text

        assert (await _delete_account(alice)).status_code == 200

        roles = await _roles(chat_id)
        assert alice_id not in roles
        assert roles[carol_id].lower().endswith("owner"), "the admin outranks the older plain member"
        assert roles[bob_id].lower().endswith("member")
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_ownership_passes_to_the_oldest_member_without_an_admin():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(f"/chats/{chat_id}/add-participants", json={"user_ids": [str(carol_id)]})
        assert r.status_code == 200, r.text

        assert (await _delete_account(alice)).status_code == 200

        roles = await _roles(chat_id)
        assert roles[bob_id].lower().endswith("owner"), "Bob joined before Carol"
        assert roles[carol_id].lower().endswith("member")
        assert alice_id not in roles
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_a_chat_nobody_else_is_in_is_deleted():
    alice, alice_id = await _register_user()
    try:
        r = await alice.post("/chats/group", json={"title": "Solo", "description": "d", "participant_ids": []})
        assert r.status_code == 200, r.text
        chat_id = uuid.UUID(r.json()["data"]["id"])

        assert (await _delete_account(alice)).status_code == 200
        assert await _scalar("SELECT count(*) FROM chats WHERE id = :c", c=chat_id) == 0
    finally:
        await alice.aclose()


async def test_personal_data_around_the_account_is_removed():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        r = await bob.post("/contact/", json={"target_user_id": str(alice_id), "alias": "Al"})
        assert r.status_code == 200, r.text
        r = await alice.post("/contact/", json={"target_user_id": str(bob_id)})
        assert r.status_code == 200, r.text
        r = await alice.post("/chat-folder/", json={"title": "mine", "chat_ids": []})
        assert r.status_code in (200, 201), r.text
        await _create_pack(alice)

        assert (await _delete_account(alice)).status_code == 200

        for table, column in (
            ("contacts", "owner_id"), ("contacts", "contact_id"), ("chat_folders", "user_id"),
            ("sticker_packs", "owner_id"), ("sticker_pack_subscriptions", "user_id"),
            ("chat_invite_links", "created_by"), ("chat_participants", "user_id"),
        ):
            assert await _scalar(
                f"SELECT count(*) FROM {table} WHERE {column} = :u", u=alice_id
            ) == 0, f"{table}.{column} must not reference the deleted account"
    finally:
        await alice.aclose()
        await bob.aclose()


# ------------------------------------------------------------------------- private chats


async def test_private_chat_with_a_deleted_peer_is_readable_but_read_only():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id, epoch, chain_key, skid, chain_identity = await _encrypted_private_chat(
            alice, alice_id, bob, bob_id
        )
        envelope = _seal(SenderChain(chain_key), chat_id, epoch, alice_id, skid, chain_identity, SECRET)
        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 201, r.text

        assert (await _delete_account(alice)).status_code == 200

        # History is still there.
        r = await bob.get(f"/chats/{chat_id}/messages")
        assert r.status_code == 200, r.text
        assert len(r.json()["data"]) == 1

        # The chat list says who it is with, neutrally, and flags it.
        chats = (await bob.get("/chats/")).json()["data"]
        mine = next(c for c in chats if c["id"] == str(chat_id))
        assert mine["peer_is_deleted"] is True
        assert mine["title"] == "Deleted user"
        assert mine["avatar_url"] is None

        r = await bob.get(f"/chats/{chat_id}")
        assert r.json()["data"]["peer_is_deleted"] is True

        # New messages are refused...
        envelope = _seal(SenderChain(chain_key), chat_id, epoch, alice_id, skid, chain_identity, b"x")
        r = await bob.post("/messages/", json={"chat_id": str(chat_id), "envelope": envelope})
        assert r.status_code == 409, r.text
        assert r.json()["error_code"] == "PEER_DELETED"

        # ...and the encrypted chat re-keyed because the peer's devices are gone.
        keys = (await bob.get(f"/crypto/chats/{chat_id}/keys")).json()["data"]
        assert keys["current_epoch"] == epoch + 1

        # A new private chat with a deleted account cannot be opened.
        r = await bob.post("/chats/private", json={"target_user_id": str(alice_id)})
        assert r.status_code == 400
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_a_private_chat_between_two_deleted_accounts_is_removed():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        r = await alice.post("/chats/private", json={"target_user_id": str(bob_id)})
        chat_id = uuid.UUID(r.json()["data"]["id"])

        assert (await _delete_account(alice)).status_code == 200
        assert await _scalar("SELECT count(*) FROM chats WHERE id = :c", c=chat_id) == 1

        assert (await _delete_account(bob)).status_code == 200
        assert await _scalar("SELECT count(*) FROM chats WHERE id = :c", c=chat_id) == 0
    finally:
        await alice.aclose()
        await bob.aclose()


# ------------------------------------------------------------- concurrency (chat row locks)


async def _delete_in_process(user_id):
    async with _session() as db:
        return await account_deletion_service.delete_account(db, user_id, None)


async def _owners(chat_id) -> list[uuid.UUID]:
    async with _session() as db:
        rows = (await db.execute(
            text("SELECT user_id FROM chat_participants WHERE chat_id = :c "
                 "AND upper(role::text) = 'OWNER'"),
            {"c": chat_id},
        )).all()
    return [r.user_id for r in rows]


async def _group_of_three():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    chat_id = await _group_with(alice, bob_id)
    r = await alice.post(f"/chats/{chat_id}/add-participants", json={"user_ids": [str(carol_id)]})
    assert r.status_code == 200, r.text
    r = await alice.post(
        f"/chats/{chat_id}/change-role", json={"user_id": str(bob_id), "role": "admin"}
    )
    assert r.status_code == 200, r.text
    return (alice, alice_id), (bob, bob_id), (carol, carol_id), chat_id


async def test_owner_and_successor_deleting_at_once_leave_exactly_one_owner():
    (alice, alice_id), (bob, bob_id), (carol, carol_id), chat_id = await _group_of_three()
    try:
        results = await asyncio.gather(
            _delete_in_process(alice_id), _delete_in_process(bob_id), return_exceptions=True
        )
        assert not [r for r in results if isinstance(r, Exception)], results

        assert await _owners(chat_id) == [carol_id]
        assert set(await _roles(chat_id)) == {carol_id}
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_deleting_the_owner_while_they_transfer_ownership_leaves_exactly_one_owner():
    from app.core.exceptions import AppException

    (alice, alice_id), (bob, bob_id), (carol, carol_id), chat_id = await _group_of_three()

    async def transfer():
        async with _session() as db:
            return await chat_services.transfer_ownership(db, chat_id, alice_id, carol_id)

    try:
        results = await asyncio.gather(
            _delete_in_process(alice_id), transfer(), return_exceptions=True
        )
        for r in results:
            assert not isinstance(r, Exception) or isinstance(r, AppException), r

        owners = await _owners(chat_id)
        assert len(owners) == 1 and owners[0] in (bob_id, carol_id)
        assert alice_id not in await _roles(chat_id)
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_channel_ownership_follows_the_same_rule():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        r = await alice.post("/chats/channel", json={
            "title": "News", "description": "d", "subscriber_ids": [str(bob_id)],
        })
        assert r.status_code == 200, r.text
        chat_id = uuid.UUID(r.json()["data"]["id"])

        assert (await _delete_account(alice)).status_code == 200

        assert await _owners(chat_id) == [bob_id]
        assert alice_id not in await _roles(chat_id)
    finally:
        await alice.aclose()
        await bob.aclose()


# ------------------------------------------------------------------------- username squat


@pytest.mark.parametrize("name", ["deleted_abcdef", "Deleted123456", "deletedabcdef"])
async def test_usernames_starting_with_deleted_are_reserved(name):
    alice, alice_id = await _register_user()
    try:
        r = await alice.patch("/profile/me", json={"username": name})
        assert r.status_code == 422, r.text

        async with httpx.AsyncClient(base_url=BASE, headers=rate_limit_bypass_headers()) as anon:
            r = await anon.post("/auth/register", json={
                "full_name": "Squatter", "username": name, "password": PASSWORD,
                "email": f"sq{uuid.uuid4().hex[:10]}@example.com",
                "phone_number": f"+38063{uuid.uuid4().int % 10_000_000:07d}",
                "public_key": "legacy", "encrypted_private_key": "legacy",
            })
            assert r.status_code == 422, r.text
    finally:
        await alice.aclose()


async def test_a_planted_placeholder_collision_does_not_block_deletion():
    """Registration cannot produce a colliding name, but a row planted by hand could. The deletion
    retries once with a random suffix instead of failing."""
    alice, alice_id = await _register_user()
    squatter, squatter_id = await _register_user()
    try:
        async with _session() as db:
            await db.execute(
                text("UPDATE users SET username = :n WHERE id = :u"),
                {"n": f"deleted-{alice_id.hex}", "u": squatter_id},
            )
            await db.commit()

        assert (await _delete_account(alice)).status_code == 200

        username = await _scalar("SELECT username FROM users WHERE id = :u", u=alice_id)
        assert username.startswith("deleted-") and username != f"deleted-{alice_id.hex}"
        assert await _scalar("SELECT deleted_at FROM users WHERE id = :u", u=alice_id) is not None
    finally:
        await alice.aclose()
        await squatter.aclose()


# --------------------------------------------------------- tombstone cannot authenticate


async def test_a_tombstone_cannot_authenticate_or_recover():
    from redis.asyncio import Redis

    alice, alice_id = await _register_user()
    try:
        former = await _me(alice)
        cookie_header = "; ".join(f"{c.name}={c.value}" for c in alice.cookies.jar)
        assert "refresh_token" in cookie_header

        assert (await _delete_account(alice)).status_code == 200
        placeholder = await _scalar("SELECT username FROM users WHERE id = :u", u=alice_id)
        placeholder_email = await _scalar("SELECT email FROM users WHERE id = :u", u=alice_id)

        async with httpx.AsyncClient(
            base_url=BASE, headers={**rate_limit_bypass_headers(), "Cookie": cookie_header}
        ) as old_session:
            assert (await old_session.get("/profile/me")).status_code in (401, 403)
            assert (await old_session.post("/auth/refresh")).status_code == 401

        async with httpx.AsyncClient(base_url=BASE, headers=rate_limit_bypass_headers()) as anon:
            for username, email in (
                (former["username"], former["email"]),
                (placeholder, placeholder_email),
            ):
                if not email.endswith(".invalid"):  # EmailStr cannot even carry the placeholder
                    r = await anon.post(
                        "/auth/forgot-password", json={"username": username, "email": email}
                    )
                    assert r.status_code == 200, "forgot-password answers identically for everyone"
                r = await anon.post("/auth/reset-password", json={
                    "username": username, "otp": "123456", "new_password": "AnotherPassw0rd!",
                    "new_public_key": "k", "new_encrypted_private_key": "k",
                })
                assert r.status_code == 400 and r.json()["error_code"] == "INVALID_OTP"

        redis = Redis.from_url(app_settings.REDIS_URL, decode_responses=True)
        try:
            assert await redis.ttl(f"password_reset:{alice_id}") == -2, "no reset code may be issued"
        finally:
            await redis.aclose()
    finally:
        await alice.aclose()


# --------------------------------------------------------------- keys and rosters


async def test_deleted_keys_are_marked_inactive_and_never_reach_the_wrap_path():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        bob_device, bob_keys = await _publish_identity(bob, bob_id)
        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        epoch = r.json()["data"]["epoch"]

        r = await bob.post("/crypto/keys/batch", json={"user_ids": [str(alice_id), str(bob_id)]})
        assert {k["is_active"] for k in r.json()["data"]} == {True}

        assert (await _delete_account(alice)).status_code == 200

        r = await bob.post("/crypto/keys/batch", json={"user_ids": [str(alice_id), str(bob_id)]})
        by_user = {k["user_id"]: k for k in r.json()["data"]}
        assert by_user[str(alice_id)]["is_active"] is False
        assert by_user[str(bob_id)]["is_active"] is True

        roster = (await bob.get(f"/crypto/chats/{chat_id}/roster")).json()["data"]
        assert str(alice_device) not in [m["device_id"] for m in roster["members"]]

        # Bob publishes a chain in the new epoch: it is accepted only for the live roster, and no
        # grant is ever created for the tombstone.
        await _publish_chain(bob, chat_id, epoch + 1, bob_id, bob_device, bob_keys)
        assert await _scalar(
            "SELECT count(*) FROM sender_key_grants WHERE recipient_user_id = :u", u=alice_id
        ) == 0
    finally:
        await alice.aclose()
        await bob.aclose()


# ------------------------------------------------------------------- read-only is complete


async def test_read_only_private_chat_also_refuses_reactions_pins_and_edits():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        bob_device, bob_keys = await _publish_identity(bob, bob_id)
        r = await alice.post("/chats/private", json={"target_user_id": str(bob_id)})
        chat_id = uuid.UUID(r.json()["data"]["id"])
        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        epoch = r.json()["data"]["epoch"]

        a_key, a_skid, a_ident = await _publish_chain(
            alice, chat_id, epoch, alice_id, alice_device, alice_keys
        )
        b_key, b_skid, b_ident = await _publish_chain(
            bob, chat_id, epoch, bob_id, bob_device, bob_keys
        )

        r = await alice.post("/messages/", json={"chat_id": str(chat_id), "envelope": _seal(
            SenderChain(a_key), chat_id, epoch, alice_id, a_skid, a_ident, b"from alice")})
        assert r.status_code == 201, r.text
        alice_msg = r.json()["data"]["_id"]

        bob_chain = SenderChain(b_key)
        r = await bob.post("/messages/", json={"chat_id": str(chat_id), "envelope": _seal(
            bob_chain, chat_id, epoch, bob_id, b_skid, b_ident, b"from bob")})
        assert r.status_code == 201, r.text
        bob_msg = r.json()["data"]["_id"]

        assert (await _delete_account(alice)).status_code == 200

        r = await bob.post(f"/messages/{alice_msg}/reactions", json={"emoji": "👍"})
        assert r.status_code == 409, r.text
        assert (await bob.delete(f"/messages/{alice_msg}/reactions/%F0%9F%91%8D")).status_code == 409
        assert (await bob.post(f"/messages/{alice_msg}/pin")).status_code == 409
        assert (await bob.post(f"/messages/{alice_msg}/unpin")).status_code == 409

        r = await bob.put(f"/messages/{bob_msg}", json={"envelope": _seal(
            bob_chain, chat_id, epoch, bob_id, b_skid, b_ident, b"edited")})
        assert r.status_code == 409 and r.json()["error_code"] == "PEER_DELETED", r.text
    finally:
        await alice.aclose()
        await bob.aclose()


# ------------------------------------------------- audit scrub and post-commit resilience


async def test_existing_audit_rows_lose_client_ip_and_failed_logins_for_the_old_name_go():
    alice, alice_id = await _register_user()
    mongo = AsyncIOMotorClient(app_settings.MONGO_URL, uuidRepresentation="standard")
    audit_log = mongo[app_settings.MONGO_DB_NAME]["security_audit"]
    try:
        former = await _me(alice)
        async with httpx.AsyncClient(base_url=BASE, headers=rate_limit_bypass_headers()) as anon:
            await anon.post(
                "/auth/login", json={"username": former["username"], "password": "wrong-pass"}
            )

        assert await audit_log.count_documents(
            {"user_id": alice_id, "client_ip": {"$ne": None}}
        ) >= 1
        assert await audit_log.count_documents(
            {"event": "login_failed", "details.username": former["username"]}
        ) >= 1

        assert (await _delete_account(alice)).status_code == 200

        assert await audit_log.count_documents(
            {"user_id": alice_id, "client_ip": {"$exists": True, "$ne": None}}
        ) == 0
        assert await audit_log.count_documents(
            {"event": "login_failed", "details.username": former["username"]}
        ) == 0
        assert await audit_log.count_documents(
            {"event": "account_deleted", "user_id": alice_id}
        ) == 1
    finally:
        mongo.close()
        await alice.aclose()


async def test_failed_reauth_is_audited_without_the_password():
    alice, alice_id = await _register_user()
    mongo = AsyncIOMotorClient(app_settings.MONGO_URL, uuidRepresentation="standard")
    try:
        await _delete_account(alice, "definitely-wrong")
        doc = await mongo[app_settings.MONGO_DB_NAME]["security_audit"].find_one(
            {"event": "password_reauth_failed", "user_id": alice_id}
        )
        assert doc is not None and doc["details"] == {"action": "delete_account"}
    finally:
        mongo.close()
        await alice.aclose()


async def test_reauth_attempts_share_one_counter_with_change_password():
    alice, alice_id = await _register_user()
    try:
        for _ in range(4):
            r = await alice.post("/auth/change-password", json={
                "old_password": "wrong", "new_password": "AnotherPassw0rd!"})
            assert r.status_code == 401
        statuses = [(await _delete_account(alice, "wrong")).status_code for _ in range(6)]
        assert 429 in statuses, "delete-account guesses must count against the change-password budget"
    finally:
        await alice.aclose()


class _FlakyRedis:
    """Delegates to a real client but fails the post-commit writes."""

    def __init__(self, real):
        self._real = real

    def __getattr__(self, name):
        if name in ("setex", "publish"):
            async def boom(*a, **k):
                raise ConnectionError("redis went away")
            return boom
        return getattr(self._real, name)


class _FlakyMongo:
    """Lets the audit insert through and fails everything else."""

    def __init__(self, real):
        self._real = real

    def __getitem__(self, name):
        return _FlakyCollection(self._real[name])


class _FlakyCollection:
    def __init__(self, real):
        self._real = real

    def __getattr__(self, name):
        if name == "insert_one":
            return getattr(self._real, name)

        async def boom(*a, **k):
            raise ConnectionError("mongo went away")
        return boom


async def test_failures_after_the_commit_still_return_success_with_cookies_cleared():
    from fastapi import Response
    from redis.asyncio import Redis
    from starlette.requests import Request

    from app.domains.users.routers import profile_routes
    from app.domains.users.schemas.user_schemas import AccountDeleteRequest

    alice, alice_id = await _register_user()
    mongo = AsyncIOMotorClient(app_settings.MONGO_URL, uuidRepresentation="standard")
    real_redis = Redis.from_url(app_settings.REDIS_URL)
    try:
        async with _session() as db:
            user = await db.get(User, alice_id)
            response = Response()
            request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)})

            result = await profile_routes.delete_me(
                data=AccountDeleteRequest(password=PASSWORD), request=request, response=response,
                user=user, db=db, redis=_FlakyRedis(real_redis),
                mongo_db=_FlakyMongo(mongo[app_settings.MONGO_DB_NAME]),
            )

        assert result.data == {"message": "Account deleted."}
        assert await _scalar("SELECT deleted_at FROM users WHERE id = :u", u=alice_id) is not None
        cookies = response.headers.getlist("set-cookie")
        assert len([c for c in cookies if "Max-Age=0" in c or "expires" in c.lower()]) >= 2, cookies

        doc = await mongo[app_settings.MONGO_DB_NAME]["security_audit"].find_one(
            {"event": "account_deleted", "user_id": alice_id}
        )
        assert doc is not None, "the audit record is written first, before anything that can fail"
    finally:
        mongo.close()
        await real_redis.aclose()
        await alice.aclose()
