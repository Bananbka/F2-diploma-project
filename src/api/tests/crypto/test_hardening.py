"""Security hardening and send idempotency, against the running app.

Covers the hashed OTP and denylist storage, the WebSocket Origin gate, strict request bodies, the
attachment cap, `Retry-After`, mail retries, `edited_at`, and `client_message_id` replay.
"""

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from smtplib import SMTPException

import aiosmtplib
import httpx
import pytest
import websockets
from pydantic import ValidationError
from redis.asyncio import Redis

from app.core.config import Settings, settings
from app.core.exceptions import AppException, app_exception_handler
from app.core.rate_limit import enforce_rate_limit
from app.domains.crypto.reference.ratchet import SenderChain
from app.domains.messages.schemas.messages_schemas import (
    MessageCreateRequest,
    MessageUpdateRequest,
)
from app.domains.users import tasks as user_tasks
from app.domains.users.services.auth_service import (
    MAX_OTP_ATTEMPTS,
    check_otp,
    generate_otp,
    otp_digest,
)
from app.infrastructure.mongo import connect_to_mongo, mongo_client

from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_identity_api import _register_user
from tests.crypto.test_rotation_api import _publish_chain, _seal

BASE = "http://localhost:8000"
WS_BASE = "ws://localhost:8000/ws"
ALLOWED_ORIGIN = "http://localhost:4200"


@pytest.fixture
async def redis():
    client = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


def _cookie_header(client: httpx.AsyncClient) -> str:
    return "; ".join(f"{k}={v}" for k, v in client.cookies.items())


# --- TB-01: OTP is stored as an HMAC ---


async def test_otp_is_stored_as_an_hmac_not_the_code(redis):
    identifier = f"hardening-{uuid.uuid4()}"
    otp = await generate_otp(redis, "hardening-otp", identifier)
    try:
        stored = await redis.get(f"hardening-otp:{identifier}")
        assert stored != otp
        assert stored == otp_digest("hardening-otp", identifier, otp)
        # Bound to what it was issued for: the same code under another subject digests differently.
        assert stored != otp_digest("hardening-otp", "someone-else", otp)
        assert len(stored) == 64
        assert 0 < await redis.ttl(f"hardening-otp:{identifier}") <= 900

        assert await check_otp(redis, "hardening-otp", identifier, otp) is True
        assert await redis.get(f"hardening-otp:{identifier}") is None
    finally:
        await redis.delete(f"hardening-otp:{identifier}", f"hardening-otp:attempts:{identifier}")


async def test_otp_is_single_use_even_under_concurrent_verification(redis):
    identifier = f"hardening-{uuid.uuid4()}"
    otp = await generate_otp(redis, "hardening-otp", identifier)
    try:
        results = await asyncio.gather(
            *(check_otp(redis, "hardening-otp", identifier, otp) for _ in range(5))
        )
        assert results.count(True) == 1
    finally:
        await redis.delete(f"hardening-otp:{identifier}", f"hardening-otp:attempts:{identifier}")


async def test_wrong_otp_is_refused_and_attempts_are_still_limited(redis):
    identifier = f"hardening-{uuid.uuid4()}"
    otp = await generate_otp(redis, "hardening-otp", identifier)
    wrong = "000000" if otp != "000000" else "000001"
    try:
        for _ in range(MAX_OTP_ATTEMPTS):
            assert await check_otp(redis, "hardening-otp", identifier, wrong) is False

        with pytest.raises(AppException) as exc:
            await check_otp(redis, "hardening-otp", identifier, otp)
        assert exc.value.error_code == "OTP_ATTEMPTS_EXCEEDED"
    finally:
        await redis.delete(f"hardening-otp:{identifier}", f"hardening-otp:attempts:{identifier}")


# --- TB-02: denylist keys are hashed, legacy keys still honoured ---


async def test_logout_denylists_the_hash_of_the_token_not_the_token(redis):
    client, _ = await _register_user()
    try:
        access = client.cookies.get("access_token")
        assert access

        r = await client.post("/auth/logout")
        assert r.status_code == 200, r.text

        digest = hashlib.sha256(access.encode()).hexdigest()
        assert await redis.get(f"blacklist:{digest}") == "revoked"
        assert await redis.get(f"blacklist:{access}") is None

        client.cookies.set("access_token", access)
        r = await client.get("/profile/me")
        assert r.status_code == 401
        assert r.json()["error_code"] == "TOKEN_REVOKED"
    finally:
        await client.aclose()


async def test_legacy_plaintext_denylist_key_is_still_honoured(redis):
    client, _ = await _register_user()
    key = f"blacklist:{client.cookies.get('access_token')}"
    try:
        await redis.setex(key, 60, "revoked")

        r = await client.get("/profile/me")
        assert r.status_code == 401
        assert r.json()["error_code"] == "TOKEN_REVOKED"
    finally:
        await redis.delete(key)
        await client.aclose()


async def test_legacy_denylist_key_also_blocks_refresh(redis):
    client, _ = await _register_user()
    key = f"blacklist:{client.cookies.get('refresh_token')}"
    try:
        await redis.setex(key, 60, "revoked")

        r = await client.post("/auth/refresh")
        assert r.status_code == 401
        assert r.json()["error_code"] == "TOKEN_REVOKED"
    finally:
        await redis.delete(key)
        await client.aclose()


# --- TB-03: WebSocket Origin gate ---


async def _ws_connects(client, headers: dict) -> bool:
    try:
        async with websockets.connect(
            WS_BASE, additional_headers={"Cookie": _cookie_header(client), **headers}
        ):
            return True
    except websockets.exceptions.InvalidStatus:
        return False


async def test_websocket_requires_an_allowed_origin():
    client, _ = await _register_user()
    try:
        assert await _ws_connects(client, {"Origin": ALLOWED_ORIGIN}) is True
        assert await _ws_connects(client, {"Origin": "http://127.0.0.1:4200"}) is True
        assert await _ws_connects(client, {"Origin": "https://evil.example"}) is False
        assert await _ws_connects(client, {}) is False

        # Near-misses: the comparison is exact, not a prefix or normalised match.
        for origin in ("null", ALLOWED_ORIGIN + "/", "http://localhost:4201", "https://localhost:4200"):
            assert await _ws_connects(client, {"Origin": origin}) is False, origin
    finally:
        await client.aclose()


# --- TB-04: docs are opt-in ---


def test_api_docs_are_off_unless_enabled():
    assert Settings.model_fields["EXPOSE_API_DOCS"].default is False
    assert ALLOWED_ORIGIN in Settings.model_fields["ALLOWED_ORIGINS"].default


def test_docs_endpoints_return_404_when_the_flag_is_off():
    """A fresh interpreter, because the app reads the flag once at import time."""
    script = (
        "from fastapi.testclient import TestClient\n"
        "import app.main as m\n"
        "c = TestClient(m.app)\n"
        "print([c.get(p).status_code for p in ('/docs', '/redoc', '/openapi.json')])\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        env={**os.environ, "EXPOSE_API_DOCS": "false"},
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert out.stdout.strip().splitlines()[-1] == "[404, 404, 404]", out.stdout + out.stderr


# --- TB-05: unknown fields are rejected ---


async def test_extra_fields_in_request_bodies_are_rejected():
    client, _ = await _register_user()
    try:
        r = await client.patch("/profile/me", json={"bio": "hi", "is_verified": True})
        assert r.status_code == 422, r.text

        r = await client.post("/auth/login", json={"username": "x", "password": "y", "role": "admin"})
        assert r.status_code == 422, r.text

        r = await client.post("/chats/private", json={"target_user_id": str(uuid.uuid4()), "x": 1})
        assert r.status_code == 422, r.text
    finally:
        await client.aclose()


# --- TB-06: attachment cap ---


def _attachment() -> dict:
    return {
        "url": f"{settings.MINIO_URL}/{settings.MINIO_MESSAGE_BUCKET}/{uuid.uuid4()}.enc",
        "name": "n.enc",
        "size": 1,
        "content_type": "application/octet-stream",
    }


def test_more_than_ten_attachments_is_refused_on_create_and_edit():
    ten = [_attachment() for _ in range(10)]
    eleven = ten + [_attachment()]

    MessageCreateRequest(chat_id=uuid.uuid4(), encrypted_content="x", attachments=ten)
    MessageUpdateRequest(encrypted_content="x", attachments=ten)

    with pytest.raises(ValidationError) as exc:
        MessageCreateRequest(chat_id=uuid.uuid4(), encrypted_content="x", attachments=eleven)
    assert exc.value.errors()[0]["type"] == "too_long"

    with pytest.raises(ValidationError) as exc:
        MessageUpdateRequest(encrypted_content="x", attachments=eleven)
    assert exc.value.errors()[0]["type"] == "too_long"


# --- TB-12: Retry-After ---


async def test_rate_limit_429_carries_retry_after(redis):
    original = settings.RATE_LIMIT_ENABLED
    settings.RATE_LIMIT_ENABLED = True
    identifier = str(uuid.uuid4())
    try:
        await enforce_rate_limit(
            redis, scope="hardening", identifier=identifier, limit=1, window_seconds=60
        )
        with pytest.raises(AppException) as exc:
            await enforce_rate_limit(
                redis, scope="hardening", identifier=identifier, limit=1, window_seconds=60
            )
    finally:
        settings.RATE_LIMIT_ENABLED = original

    assert exc.value.status_code == 429
    response = await app_exception_handler(None, exc.value)
    assert response.status_code == 429
    assert 1 <= int(response.headers["retry-after"]) <= 60


# --- TB-29: mail retries ---


@pytest.fixture
def _smtp_configured(monkeypatch):
    monkeypatch.setattr(settings, "SMTP_USER", "u")
    monkeypatch.setattr(settings, "SMTP_PASSWORD", "p")


@pytest.mark.parametrize("error", [SMTPException("boom"), OSError("down"), aiosmtplib.SMTPException("boom")])
def test_send_email_retries_transient_failures_then_fails(monkeypatch, _smtp_configured, error):
    calls = []

    async def failing(email_to, **kwargs):
        calls.append(email_to)
        raise error

    monkeypatch.setattr(user_tasks, "send_password_reset_email", failing)

    result = user_tasks.send_email.apply(
        args=(user_tasks.EmailTasks.PASSWORD_RESET.value, "a@example.com"),
        kwargs={"otp": "123456"},
    )

    assert len(calls) == 4  # first attempt + max_retries=3
    assert result.failed()


@pytest.mark.parametrize(
    "error",
    [
        aiosmtplib.SMTPResponseException(550, "mailbox unavailable"),
        aiosmtplib.SMTPResponseException(535, "bad credentials"),
    ],
)
def test_send_email_does_not_retry_permanent_rejections(monkeypatch, _smtp_configured, error):
    calls = []

    async def rejected(email_to, **kwargs):
        calls.append(email_to)
        raise error

    monkeypatch.setattr(user_tasks, "send_password_reset_email", rejected)

    result = user_tasks.send_email.apply(
        args=(user_tasks.EmailTasks.PASSWORD_RESET.value, "a@example.com"),
        kwargs={"otp": "123456"},
    )

    assert len(calls) == 1
    assert result.get() is False


def test_send_email_retries_smtp_4xx(monkeypatch, _smtp_configured):
    calls = []

    async def greylisted(email_to, **kwargs):
        calls.append(email_to)
        raise aiosmtplib.SMTPResponseException(451, "try again later")

    monkeypatch.setattr(user_tasks, "send_password_reset_email", greylisted)

    result = user_tasks.send_email.apply(
        args=(user_tasks.EmailTasks.PASSWORD_RESET.value, "a@example.com"),
        kwargs={"otp": "123456"},
    )

    assert len(calls) == 4
    assert result.failed()


def test_send_email_recovers_when_a_retry_succeeds(monkeypatch, _smtp_configured):
    calls = []

    async def flaky(email_to, **kwargs):
        calls.append(email_to)
        if len(calls) < 3:
            raise SMTPException("transient")

    monkeypatch.setattr(user_tasks, "send_password_reset_email", flaky)

    result = user_tasks.send_email.apply(
        args=(user_tasks.EmailTasks.PASSWORD_RESET.value, "a@example.com"),
        kwargs={"otp": "123456"},
    )

    assert len(calls) == 3
    assert result.get() is True


# --- TB-14: edited_at ---


async def test_edit_sets_edited_at():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        r = await alice.post("/messages", json={"chat_id": str(chat_id), "encrypted_content": "a"})
        msg = r.json()["data"]
        assert msg["edited_at"] is None

        # Mongo stores milliseconds, so compare against a millisecond-truncated lower bound.
        before = datetime.now(timezone.utc)
        before = before.replace(microsecond=before.microsecond // 1000 * 1000)

        r = await alice.put(f"/messages/{msg['_id']}", json={"encrypted_content": "b"})
        after = datetime.now(timezone.utc)
        assert r.status_code == 200, r.text

        edited_at = datetime.fromisoformat(r.json()["data"]["edited_at"])
        assert edited_at.utcoffset() is not None, "edited_at must be timezone-aware"
        assert before <= edited_at <= after
    finally:
        await alice.aclose()
        await bob.aclose()


# --- TB-10 / TB-11 / TB-13: route, status codes, idempotent send ---


async def test_post_without_trailing_slash_is_not_redirected_and_returns_201():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        body = {"chat_id": str(chat_id), "encrypted_content": "hi"}

        r = await alice.post("/messages", json=body, follow_redirects=False)
        assert r.status_code == 201, r.text

        r = await alice.post("/messages/", json=body, follow_redirects=False)
        assert r.status_code == 201, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_replayed_client_message_id_returns_the_original_with_200():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        cid = str(uuid.uuid4())
        body = {"chat_id": str(chat_id), "encrypted_content": "once", "client_message_id": cid}

        first = await alice.post("/messages", json=body)
        assert first.status_code == 201, first.text

        # A retry may re-seal, so the content itself is not compared; the original is returned.
        second = await alice.post("/messages", json={**body, "encrypted_content": "re-sealed"})
        assert second.status_code == 200, second.text
        assert second.json()["data"]["_id"] == first.json()["data"]["_id"]
        assert second.json()["data"]["encrypted_content"] == "once"
        assert second.json()["data"]["client_message_id"] == cid

        history = await alice.get(f"/chats/{chat_id}/messages")
        assert len(history.json()["data"]) == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_reusing_a_client_message_id_for_a_different_message_is_a_conflict():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        cid = str(uuid.uuid4())
        body = {"chat_id": str(chat_id), "encrypted_content": "one", "client_message_id": cid}
        assert (await alice.post("/messages", json=body)).status_code == 201

        for changed in (
            {"reply_to_message_id": "507f1f77bcf86cd799439011"},
            {"attachments": [_attachment()]},
            {
                "forwarded_from": {
                    "user_id": str(uuid.uuid4()),
                    "created_at": "2026-01-01T00:00:00Z",
                }
            },
        ):
            r = await alice.post("/messages", json={**body, **changed})
            assert r.status_code == 409, r.text
            assert r.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"

        history = await alice.get(f"/chats/{chat_id}/messages")
        assert len(history.json()["data"]) == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_replay_is_broadcast_again_so_a_lost_publish_is_recoverable():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        body = {
            "chat_id": str(chat_id),
            "encrypted_content": "once",
            "client_message_id": str(uuid.uuid4()),
        }

        async with websockets.connect(
            WS_BASE,
            additional_headers={"Cookie": _cookie_header(bob), "Origin": ALLOWED_ORIGIN},
        ) as socket:
            first = await alice.post("/messages", json=body)
            assert first.status_code == 201
            sent = json.loads(await asyncio.wait_for(socket.recv(), 5))
            assert sent["event_type"] == "new_message"

            assert (await alice.post("/messages", json=body)).status_code == 200
            again = json.loads(await asyncio.wait_for(socket.recv(), 5))
            assert again["event_type"] == "new_message"
            assert again["payload"]["_id"] == sent["payload"]["_id"]
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_replay_after_an_epoch_bump_still_returns_the_original():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)
        await _publish_identity(carol, carol_id)

        r = await alice.post("/chats/group", json={
            "title": "G", "description": "d",
            "participant_ids": [str(bob_id), str(carol_id)],
        })
        chat_id = uuid.UUID(r.json()["data"]["id"])
        await alice.post(f"/crypto/chats/{chat_id}/enable")
        chain_key, skid, chain_identity = await _publish_chain(
            alice, chat_id, 1, alice_id, alice_device, alice_keys
        )
        chain = SenderChain(chain_key)
        cid = str(uuid.uuid4())

        first = await alice.post("/messages", json={
            "chat_id": str(chat_id),
            "client_message_id": cid,
            "envelope": _seal(chain, chat_id, 1, alice_id, skid, chain_identity),
        })
        assert first.status_code == 201, first.text

        # Removing carol rotates to epoch 2; a fresh send under epoch 1 is now stale.
        await alice.post(f"/chats/{chat_id}/delete-participants",
                         json={"user_ids": [str(carol_id)]})

        replay = await alice.post("/messages", json={
            "chat_id": str(chat_id),
            "client_message_id": cid,
            "envelope": _seal(chain, chat_id, 1, alice_id, skid, chain_identity, b"re-sealed"),
        })
        assert replay.status_code == 200, replay.text
        assert replay.json()["data"]["_id"] == first.json()["data"]["_id"]
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_replay_by_a_removed_member_is_forbidden():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        body = {
            "chat_id": str(chat_id),
            "encrypted_content": "x",
            "client_message_id": str(uuid.uuid4()),
        }
        assert (await bob.post("/messages", json=body)).status_code == 201

        r = await alice.post(f"/chats/{chat_id}/delete-participants",
                             json={"user_ids": [str(bob_id)]})
        assert r.status_code == 200, r.text

        r = await bob.post("/messages", json=body)
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_concurrent_sends_with_one_client_message_id_store_one_message():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        body = {
            "chat_id": str(chat_id),
            "encrypted_content": "race",
            "client_message_id": str(uuid.uuid4()),
        }

        responses = await asyncio.gather(*(alice.post("/messages", json=body) for _ in range(6)))

        assert sorted(r.status_code for r in responses).count(201) == 1
        assert {r.status_code for r in responses} <= {200, 201}
        assert len({r.json()["data"]["_id"] for r in responses}) == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_client_message_id_is_scoped_to_sender_and_checked_after_authorization():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    mallory, _ = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        cid = str(uuid.uuid4())
        body = {"chat_id": str(chat_id), "encrypted_content": "x", "client_message_id": cid}

        first = await alice.post("/messages", json=body)
        assert first.status_code == 201, first.text

        # Another member reusing the id is a different message.
        other = await bob.post("/messages", json=body)
        assert other.status_code == 201, other.text
        assert other.json()["data"]["_id"] != first.json()["data"]["_id"]

        # A non-member learns nothing about whether the id exists.
        r = await mallory.post("/messages", json=body)
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
        await mallory.aclose()


async def test_a_new_client_message_id_does_not_bypass_content_validation():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        envelope = {
            "alg": "x", "epoch": 1, "skid": str(uuid.uuid4()), "idx": 0,
            "n": "n", "ct": "c", "sig": "s",
        }

        r = await alice.post(
            "/messages",
            json={
                "chat_id": str(chat_id),
                "envelope": envelope,
                "client_message_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "ENVELOPE_NOT_ALLOWED"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_idempotency_index_is_partial_and_unique():
    await connect_to_mongo()
    indexes = await mongo_client.db["messages"].index_information()

    index = indexes["ux_chat_sender_client_msg"]
    assert index["unique"] is True
    assert index["partialFilterExpression"] == {"client_message_id": {"$type": "binData"}}


# --- WebSocket session revocation ---


async def _login_again(username: str) -> httpx.AsyncClient:
    from tests.crypto.test_identity_api import rate_limit_bypass_headers

    second = httpx.AsyncClient(
        base_url=BASE, timeout=30.0, headers=rate_limit_bypass_headers()
    )
    r = await second.post(
        "/auth/login", json={"username": username, "password": "TestPassw0rd!"}
    )
    assert r.status_code == 200, r.text
    return second


def _ws(client):
    return websockets.connect(
        WS_BASE,
        additional_headers={"Cookie": _cookie_header(client), "Origin": ALLOWED_ORIGIN},
    )


async def _closed_with(socket, timeout: float = 5.0):
    """The close code if the server closes the socket within `timeout`, else None."""
    try:
        while True:
            await asyncio.wait_for(socket.recv(), timeout)
    except websockets.exceptions.ConnectionClosed:
        return socket.close_code
    except asyncio.TimeoutError:
        return None


async def test_logout_closes_only_the_sockets_using_the_revoked_token():
    first, _ = await _register_user()
    username = (await first.get("/profile/me")).json()["data"]["username"]
    second = await _login_again(username)
    try:
        async with _ws(first) as first_socket, _ws(second) as second_socket:
            assert (await first.post("/auth/logout")).status_code == 200

            assert await _closed_with(first_socket) == 4401
            # The other device holds a different, unrevoked token and must stay connected.
            assert await _closed_with(second_socket, timeout=2.0) is None
    finally:
        await first.aclose()
        await second.aclose()


async def test_password_change_closes_every_older_socket():
    first, _ = await _register_user()
    username = (await first.get("/profile/me")).json()["data"]["username"]
    second = await _login_again(username)
    try:
        async with _ws(first) as first_socket, _ws(second) as second_socket:
            r = await second.post("/auth/change-password", json={
                "old_password": "TestPassw0rd!",
                "new_password": "BrandNewPassw0rd!",
                "rewrapped_identities": [],
            })
            assert r.status_code == 200, r.text

            assert await _closed_with(first_socket) == 4401
            assert await _closed_with(second_socket) == 4401
    finally:
        await first.aclose()
        await second.aclose()


@pytest.mark.skipif(
    settings.WS_SESSION_RECHECK_SECONDS > 10,
    reason="needs WS_SESSION_RECHECK_SECONDS <= 10 on the server",
)
async def test_periodic_recheck_closes_a_socket_revoked_without_an_event(redis):
    client, _ = await _register_user()
    key = f"blacklist:{hashlib.sha256(client.cookies.get('access_token').encode()).hexdigest()}"
    try:
        async with _ws(client) as socket:
            # Denylisted directly: nothing is published, so only the timer can notice.
            await redis.setex(key, 60, "revoked")
            code = await _closed_with(socket, timeout=settings.WS_SESSION_RECHECK_SECONDS + 5)
            assert code == 4401
    finally:
        await redis.delete(key)
        await client.aclose()


# --- HTTP Origin check ---


async def test_state_changing_requests_from_foreign_origins_are_refused():
    client, _ = await _register_user()
    try:
        evil = {"Origin": "https://evil.example"}
        for method in ("post", "put", "patch", "delete"):
            r = await getattr(client, method)("/profile/me", headers=evil)
            assert r.status_code == 403, (method, r.text)
            assert r.json()["error_code"] == "ORIGIN_NOT_ALLOWED"

        r = await client.post("/auth/logout", headers={"Origin": "null"})
        assert r.status_code == 403

        # Reads, allow-listed origins and requests with no Origin header are unaffected.
        assert (await client.get("/profile/me", headers=evil)).status_code == 200
        r = await client.patch("/profile/me", json={"bio": "x"}, headers={"Origin": ALLOWED_ORIGIN})
        assert r.status_code == 200, r.text
        r = await client.patch("/profile/me", json={"bio": "y"})
        assert r.status_code == 200, r.text
    finally:
        await client.aclose()


def test_old_ws_origins_name_is_still_read_as_a_fallback(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("ALLOWED_WS_ORIGINS", '["https://old.example"]')
    assert Settings().ALLOWED_ORIGINS == ["https://old.example"]

    monkeypatch.setenv("ALLOWED_ORIGINS", '["https://new.example"]')
    assert Settings().ALLOWED_ORIGINS == ["https://new.example"]


# --- WebSocket inbound hygiene ---


async def test_typing_payload_is_stripped_before_relay():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        async with _ws(alice) as a_socket, _ws(bob) as b_socket:
            await asyncio.sleep(0.5)  # let both sockets finish subscribing
            await a_socket.send(json.dumps({
                "event_type": "typing_start",
                "chat_id": str(chat_id),
                "payload": {"smuggled": "data", "html": "<b>x</b>"},
            }))
            while True:
                frame = json.loads(await asyncio.wait_for(b_socket.recv(), 5))
                if frame["event_type"] == "typing_start":
                    break
            assert frame["payload"] == {}
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_flooding_typing_frames_is_throttled():
    alice, _ = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        async with _ws(alice) as a_socket, _ws(bob) as b_socket:
            await asyncio.sleep(0.5)  # let both sockets finish subscribing
            frame = json.dumps({"event_type": "typing_start", "chat_id": str(chat_id), "payload": {}})
            for _ in range(60):
                await a_socket.send(frame)

            while True:
                notice = json.loads(await asyncio.wait_for(a_socket.recv(), 5))
                if notice["event_type"] == "error":
                    break
            assert notice["payload"]["error_code"] == "RATE_LIMITED"

            relayed = 0
            try:
                while True:
                    f = json.loads(await asyncio.wait_for(b_socket.recv(), 1.5))
                    relayed += f["event_type"] == "typing_start"
            except asyncio.TimeoutError:
                pass
            assert 1 <= relayed <= 15
    finally:
        await alice.aclose()
        await bob.aclose()


def test_inbound_payload_whitelist_covers_every_relayed_event():
    from app.domains.messages.routes.ws_router import ALLOWED_INBOUND_PAYLOAD_KEYS

    assert ALLOWED_INBOUND_PAYLOAD_KEYS["typing_start"] == frozenset()
    assert ALLOWED_INBOUND_PAYLOAD_KEYS["typing_stop"] == frozenset()
    assert ALLOWED_INBOUND_PAYLOAD_KEYS["message_read"] == frozenset({"last_read_message_id"})


# --- login timing ---


async def test_login_with_an_unknown_user_costs_a_password_hash_too():
    import statistics
    import time

    from tests.crypto.test_identity_api import rate_limit_bypass_headers

    client, _ = await _register_user()
    username = (await client.get("/profile/me")).json()["data"]["username"]
    anon = httpx.AsyncClient(base_url=BASE, timeout=30.0, headers=rate_limit_bypass_headers())
    try:
        async def timed(name):
            start = time.perf_counter()
            r = await anon.post("/auth/login", json={"username": name, "password": "WrongPassw0rd!"})
            assert r.status_code == 401, r.text
            return time.perf_counter() - start

        known = statistics.median([await timed(username) for _ in range(5)])
        unknown = statistics.median([await timed(f"nobody{uuid.uuid4().hex[:10]}") for _ in range(5)])

        # bcrypt dominates a real check (~100 ms+); without the dummy compare the unknown case
        # is an order of magnitude faster.
        assert unknown > known * 0.5, (known, unknown)
    finally:
        await anon.aclose()
        await client.aclose()
