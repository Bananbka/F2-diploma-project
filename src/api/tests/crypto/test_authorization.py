"""Regression tests for the authorization holes found in the security review.

Each of these passed silently before the fix. They are grouped here rather than scattered through
the feature suites because what they have in common is the failure mode: an endpoint that looked
authorised because *some* check ran, while the check that mattered did not.
"""

import uuid

import httpx
import websockets

from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_identity_api import _register_user
from tests.crypto.test_rotation_api import _publish_chain, _seal

BASE = "http://localhost:8000"
WS_BASE = "ws://localhost:8000/ws"


async def _private_chat(client, peer_id) -> uuid.UUID:
    r = await client.post("/chats/private", json={"target_user_id": str(peer_id)})
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["id"])


def _cookie_header(client: httpx.AsyncClient) -> str:
    return "; ".join(f"{k}={v}" for k, v in client.cookies.items())


async def _read_otp(key: str) -> str:
    """Read a one-time code straight out of Redis.

    The code only ever reaches the user by email, and there is no mail server in the test
    environment. Reading it here keeps the reset flow testable end to end without adding a
    back door to the application itself.
    """
    from redis.asyncio import Redis

    from app.core.config import settings

    redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        code = await redis.get(key)
        assert code, f"no OTP stored at {key}"
        return code
    finally:
        await redis.aclose()


async def _publish_identity_with_device(client, user_id, device_id=None):
    """Publish an identity, optionally reusing a device id the caller already holds.

    `test_epoch_api._publish_identity` always mints a fresh device, which cannot express the
    case that matters here: the same installation publishing again after its device was revoked.
    """
    from app.domains.crypto.reference.identity import (
        generate_identity,
        wrap_private_bundle,
    )
    from app.domains.crypto.reference.primitives import b64u_encode

    device_id = device_id or uuid.uuid4()
    bundle = generate_identity(user_id, device_id)
    wrapped, kdf = wrap_private_bundle(bundle, "TestPassw0rd!")

    r = await client.post(
        "/crypto/identity",
        json={
            "device_id": str(device_id),
            "display_name": "test",
            "identity_public_key": b64u_encode(bundle.identity_public),
            "signing_public_key": b64u_encode(bundle.signing_public),
            "identity_key_signature": b64u_encode(bundle.identity_key_signature),
            "encrypted_private_bundle": wrapped,
            "kdf_params": kdf,
        },
    )
    assert r.status_code == 200, r.text
    return device_id, bundle


# --------------------------------------------------------------------------------------------
# The edit path skipped every envelope check the send path performs.
# --------------------------------------------------------------------------------------------


async def test_edit_is_rejected_under_a_stale_epoch():
    """An edit used to bypass epoch enforcement entirely.

    `update_message` never called `_validate_envelope`, so a member could re-seal a message under
    a superseded epoch — one whose keys a just-removed member still holds — and the server stored
    it. Everything the strict-equality check on the send path exists to prevent was reachable
    through PUT.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)
        await _publish_identity(carol, carol_id)

        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(
            f"/chats/{chat_id}/add-participants", json={"user_ids": [str(carol_id)]}
        )
        assert r.status_code == 200, r.text

        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 200, r.text
        epoch = r.json()["data"]["epoch"]

        chain_key, skid, chain_identity = await _publish_chain(
            alice, chat_id, epoch, alice_id, alice_device, alice_keys
        )
        from app.domains.crypto.reference.ratchet import SenderChain

        chain = SenderChain(chain_key)

        envelope = _seal(chain, chat_id, epoch, alice_id, skid, chain_identity)
        r = await alice.post(
            "/messages/", json={"chat_id": str(chat_id), "envelope": envelope}
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        # Carol is removed, which re-keys the chat. Carol keeps every key she already held.
        r = await alice.post(
            f"/chats/{chat_id}/delete-participants", json={"user_ids": [str(carol_id)]}
        )
        assert r.status_code == 200, r.text

        # Editing under the old epoch would write content Carol can still read.
        stale = _seal(
            chain,
            chat_id,
            epoch,
            alice_id,
            skid,
            chain_identity,
            body=b"secret after removal",
        )
        r = await alice.put(f"/messages/{message_id}", json={"envelope": stale})

        assert r.status_code == 409, r.text
        assert r.json()["error_code"] == "EPOCH_STALE"
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_edit_cannot_claim_another_members_sender_key():
    """The send path refuses a chain you do not own; the edit path did not check at all."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        bob_device, bob_keys = await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        epoch = r.json()["data"]["epoch"]

        a_key, a_skid, a_identity = await _publish_chain(
            alice, chat_id, epoch, alice_id, alice_device, alice_keys
        )
        b_key, b_skid, b_identity = await _publish_chain(
            bob, chat_id, epoch, bob_id, bob_device, bob_keys
        )

        from app.domains.crypto.reference.ratchet import SenderChain

        alice_chain = SenderChain(a_key)

        envelope = _seal(alice_chain, chat_id, epoch, alice_id, a_skid, a_identity)
        r = await alice.post(
            "/messages/", json={"chat_id": str(chat_id), "envelope": envelope}
        )
        message_id = r.json()["data"]["_id"]

        # Alice edits her own message, but names Bob's chain — which would attribute the edit to
        # a key Bob published and Alice does not own.
        bob_chain = SenderChain(b_key)
        forged = _seal(
            bob_chain, chat_id, epoch, alice_id, b_skid, b_identity, body=b"not mine"
        )

        r = await alice.put(f"/messages/{message_id}", json={"envelope": forged})

        assert r.status_code == 403, r.text
        assert r.json()["error_code"] == "SENDER_KEY_NOT_YOURS"
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------------------------
# The WebSocket took chat_id from the frame with no membership check.
# --------------------------------------------------------------------------------------------


async def test_socket_refuses_read_receipts_for_a_chat_you_are_not_in():
    """`mark_messages_as_read` reached Mongo with no Postgres check in front of it.

    Any authenticated user could flip `is_read` across a conversation they had never been part
    of, wiping every member's unread count. Access control lives in Postgres and content lives in
    Mongo, so a Mongo write with no Postgres check is unauthorised by construction.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)

        r = await alice.post(
            "/messages/",
            json={
                "chat_id": str(chat_id),
                "encrypted_content": "hello",
            },
        )
        assert r.status_code == 200, r.text
        message_id = r.json()["data"]["_id"]

        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(mallory)}
        ) as socket:
            await socket.send(
                f'{{"event_type":"message_read","chat_id":"{chat_id}",'
                f'"payload":{{"last_read_message_id":"{message_id}"}}}}'
            )
            reply = await socket.recv()

        assert '"error"' in reply
        assert "FORBIDDEN" in reply

        # Bob's unread count must be untouched by the outsider's attempt.
        r = await bob.get("/chats/")
        chat = next(c for c in r.json()["data"] if c["id"] == str(chat_id))
        assert chat["unread_count"] == 1, (
            "an outsider must not be able to mark a chat read"
        )
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_socket_refuses_typing_for_a_chat_you_are_not_in():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    mallory, mallory_id = await _register_user()

    try:
        chat_id = await _private_chat(alice, bob_id)

        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(mallory)}
        ) as socket:
            await socket.send(
                f'{{"event_type":"typing_start","chat_id":"{chat_id}","payload":{{}}}}'
            )
            reply = await socket.recv()

        assert "FORBIDDEN" in reply
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_socket_survives_a_malformed_frame():
    """A non-JSON frame used to raise past the disconnect handler and drop the connection."""
    alice, alice_id = await _register_user()

    try:
        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(alice)}
        ) as socket:
            await socket.send("this is not json")
            reply = await socket.recv()
            assert '"error"' in reply

            # Still usable afterwards, which is the whole point.
            await socket.send('{"event_type":"typing_start","payload":{}}')
    finally:
        await alice.aclose()


# --------------------------------------------------------------------------------------------
# Session revocation, directory exposure, membership lifecycle.
# --------------------------------------------------------------------------------------------


async def test_refresh_respects_forced_logout():
    """A stolen refresh token used to outlive every revocation the system had.

    /auth/refresh checked only the signature. The access token it minted carried a fresh `iat`,
    so it cleared the `force_logout` cutoff that changing a password sets — which is exactly the
    action a user takes when they believe they have been compromised.
    """
    client, user_id = await _register_user()

    try:
        r = await client.post(
            "/auth/change-password",
            json={
                "old_password": "TestPassw0rd!",
                "new_password": "NewPassw0rd!",
            },
        )
        assert r.status_code == 200, r.text

        # The cookies from the change-password response are current, so refresh works.
        r = await client.post("/auth/refresh")
        assert r.status_code == 200, r.text

        # A refresh token issued *before* the cutoff must not work, even though it is validly
        # signed and unexpired.
        async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as stale:
            r = await stale.post(
                "/auth/login",
                json={
                    "username": (await client.get("/profile/me")).json()["data"][
                        "username"
                    ],
                    "password": "NewPassw0rd!",
                },
            )
            assert r.status_code == 200, r.text
            old_refresh = stale.cookies.get("refresh_token")

            r = await stale.post(
                "/auth/change-password",
                json={
                    "old_password": "NewPassw0rd!",
                    "new_password": "ThirdPassw0rd!",
                },
            )
            assert r.status_code == 200, r.text

            async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as replay:
                replay.cookies.set("refresh_token", old_refresh)
                r = await replay.post("/auth/refresh")

                assert r.status_code == 401, r.text
                assert r.json()["error_code"] == "SESSION_EXPIRED"
    finally:
        await client.aclose()


async def test_logout_revokes_the_refresh_token_too():
    """Logout blacklisted only the access token, leaving the refresh cookie fully usable."""
    client, user_id = await _register_user()

    try:
        refresh_token = client.cookies.get("refresh_token")

        r = await client.post("/auth/logout")
        assert r.status_code == 200, r.text

        async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as replay:
            replay.cookies.set("refresh_token", refresh_token)
            r = await replay.post("/auth/refresh")

            assert r.status_code == 401, r.text
            assert r.json()["error_code"] == "TOKEN_REVOKED"
    finally:
        await client.aclose()


async def test_user_lookup_does_not_leak_email_or_phone():
    """GET /users/{username} returned the full record, email and phone included.

    Combined with /users/search, which hands out usernames, that was a complete directory export
    of every account's contact details to any signed-in user.
    """
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        bob_username = (await bob.get("/profile/me")).json()["data"]["username"]

        r = await alice.get(f"/users/{bob_username}")
        assert r.status_code == 200, r.text
        data = r.json()["data"]

        assert "email" not in data
        assert "phone_number" not in data
        assert data["username"] == bob_username
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_search_wildcards_cannot_list_every_account():
    """`%` reached ILIKE unescaped, so one search returned a page of the whole user table."""
    alice, alice_id = await _register_user()

    try:
        r = await alice.get("/users/search", params={"query": "%"})
        assert r.status_code == 200, r.text
        assert r.json()["data"] == []
    finally:
        await alice.aclose()


async def test_owner_can_transfer_ownership_and_then_leave():
    """The owner was trapped: no transfer endpoint existed and change_role refuses OWNER."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 400
        assert r.json()["error_code"] == "OWNER_CANNOT_LEAVE"

        r = await alice.post(
            f"/chats/{chat_id}/transfer-ownership", json={"user_id": str(bob_id)}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["role"] == "owner"

        r = await alice.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 200, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_owner_can_delete_a_group_and_its_messages():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(
            "/messages/", json={"chat_id": str(chat_id), "encrypted_content": "x"}
        )
        assert r.status_code == 200, r.text

        # A member cannot delete it.
        r = await bob.delete(f"/chats/{chat_id}")
        assert r.status_code == 403, r.text

        r = await alice.delete(f"/chats/{chat_id}")
        assert r.status_code == 200, r.text

        r = await alice.get(f"/chats/{chat_id}")
        assert r.status_code == 403, "the chat and its membership must be gone"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_group_chats_are_not_duplicated_in_the_chat_list():
    """The counterpart join was unrestricted, so a group produced one row per other member."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)
        r = await alice.post(
            f"/chats/{chat_id}/add-participants", json={"user_ids": [str(carol_id)]}
        )
        assert r.status_code == 200, r.text

        r = await alice.get("/chats/")
        assert r.status_code == 200, r.text

        ids = [c["id"] for c in r.json()["data"]]
        assert ids.count(str(chat_id)) == 1, (
            f"chat appeared {ids.count(str(chat_id))} times"
        )
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_empty_participant_list_is_a_validation_error_not_a_crash():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()

    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(
            f"/chats/{chat_id}/add-participants", json={"user_ids": []}
        )
        assert r.status_code == 422, r.text

        r = await alice.post(
            f"/chats/{chat_id}/add-participants",
            json={
                "user_ids": [str(uuid.uuid4())],
            },
        )
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "UNKNOWN_USER"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_profile_patch_tolerates_a_null_username():
    """An explicit null reached re.fullmatch(pattern, None) and surfaced as a 500."""
    client, user_id = await _register_user()

    try:
        r = await client.patch(
            "/profile/me", json={"full_name": "Still Me", "username": None}
        )
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "INVALID_USERNAME"

        # And a partial update without full_name, which the schema used to require on a PATCH.
        r = await client.patch("/profile/me", json={"bio": "just a bio"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["bio"] == "just a bio"
    finally:
        await client.aclose()


async def test_forgot_password_does_not_reveal_whether_an_account_exists():
    client, user_id = await _register_user()

    try:
        known = (await client.get("/profile/me")).json()["data"]

        async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as anon:
            real = await anon.post(
                "/auth/forgot-password",
                json={
                    "username": known["username"],
                    "email": known["email"],
                },
            )
            fake = await anon.post(
                "/auth/forgot-password",
                json={
                    "username": f"nobody{uuid.uuid4().hex[:8]}",
                    "email": "nobody@example.com",
                },
            )

        assert real.status_code == fake.status_code == 200
        assert real.json() == fake.json(), "the response must not distinguish the two"
    finally:
        await client.aclose()


# --------------------------------------------------------------------------------------------
# Key lifecycle around revocation.
# --------------------------------------------------------------------------------------------


async def test_identity_can_be_republished_after_every_device_is_revoked():
    """The documented recovery path after a password reset, which used to 500.

    Reset revokes every device, and the client then publishes a fresh identity from the same
    device id it kept in localStorage. `next_version` was derived from the *active* key, so with
    none active it restarted at 1 — colliding with the version 1 row retained for audit, because
    `uq_identity_key_device_version` covers superseded rows too.
    """
    client, user_id = await _register_user()

    try:
        device_id, _ = await _publish_identity_with_device(client, user_id)

        r = await client.get("/crypto/identity/me")
        assert r.json()["data"][0]["version"] == 1

        # Reset destroys the identity and revokes the device.
        username = (await client.get("/profile/me")).json()["data"]["username"]
        email = (await client.get("/profile/me")).json()["data"]["email"]

        r = await client.post(
            "/auth/forgot-password", json={"username": username, "email": email}
        )
        assert r.status_code == 200, r.text

        otp = await _read_otp(f"password_reset:{user_id}")
        r = await client.post(
            "/auth/reset-password",
            json={
                "username": username,
                "otp": otp,
                "new_password": "NewPassw0rd!",
                "new_public_key": "legacy",
                "new_encrypted_private_key": "legacy",
            },
        )
        assert r.status_code == 200, r.text

        # Log back in — reset forces every session out.
        async with httpx.AsyncClient(base_url=BASE, timeout=30.0) as fresh:
            r = await fresh.post(
                "/auth/login", json={"username": username, "password": "NewPassw0rd!"}
            )
            assert r.status_code == 200, r.text

            # The same device id publishes again. This is the case that used to collide.
            new_device_id, _ = await _publish_identity_with_device(
                fresh, user_id, device_id=device_id
            )
            assert new_device_id == device_id

            r = await fresh.get("/crypto/identity/me")
            assert r.status_code == 200, r.text
            keys = r.json()["data"]

            assert len(keys) == 1, "exactly one active key for the device"
            assert keys[0]["version"] == 2, (
                "the version must advance past the retained row"
            )
    finally:
        await client.aclose()
