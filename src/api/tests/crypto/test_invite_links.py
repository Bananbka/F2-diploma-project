"""Invite links: authorization scoping, the join flow's reuse of `add_chat_participants` (member
cap and epoch rotation included), and the `max_uses` race.

Authorization and lifecycle tests run over HTTP against the running app, the same way
`test_authorization.py` and `test_message_features.py` do. The member-cap test instead calls
`invite_link_services`/`chat_services` directly, in-process, on its own engine — the same pattern
`test_group_cap.py` uses — because `epoch_service.MAX_E2E_GROUP_MEMBERS` is monkeypatched, and a
monkeypatch in the test process has no effect on the separate `uvicorn` process the HTTP tests
talk to.
"""

import asyncio
import contextlib
import uuid

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings as app_settings
from app.core.exceptions import AppException
from app.core.rate_limit import enforce_rate_limit
from app.domains.chats.routers.invite_link_routes import (
    INVITE_LIST_LIMIT,
    INVITE_LIST_WINDOW,
)
from app.domains.chats.services import chat_services, invite_link_services
from app.domains.crypto.services import epoch_service

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user

BASE = "http://localhost:8000"


@contextlib.asynccontextmanager
async def _session():
    engine = create_async_engine(app_settings.DATABASE_URL)
    try:
        async with async_sessionmaker(bind=engine, expire_on_commit=False)() as db:
            yield db
    finally:
        await engine.dispose()


async def _create_link(client, chat_id, **body) -> dict:
    r = await client.post(f"/chats/{chat_id}/invite-links", json=body)
    assert r.status_code == 200, r.text
    return r.json()["data"]


# --------------------------------------------------------------------------------------------
# Creation / listing / revocation authorization
# --------------------------------------------------------------------------------------------


async def test_plain_member_cannot_create_invite_link():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)  # bob joins as MEMBER

        r = await bob.post(f"/chats/{chat_id}/invite-links", json={})
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_plain_member_cannot_list_or_revoke_invite_links():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id)

        r = await bob.get(f"/chats/{chat_id}/invite-links")
        assert r.status_code == 403, r.text

        r = await bob.post(f"/invite-links/{link['token']}/revoke")
        assert r.status_code == 403, r.text
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_owner_can_create_list_and_revoke_invite_link():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id)
        assert link["chat_id"] == str(chat_id)
        assert link["use_count"] == 0
        assert link["is_active"] is True

        r = await alice.get(f"/chats/{chat_id}/invite-links")
        assert r.status_code == 200, r.text
        tokens = [entry["token"] for entry in r.json()["data"]]
        assert link["token"] in tokens

        r = await alice.post(f"/invite-links/{link['token']}/revoke")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["revoked_at"] is not None

        # Revoked links drop out of the active listing.
        r = await alice.get(f"/chats/{chat_id}/invite-links")
        assert link["token"] not in [entry["token"] for entry in r.json()["data"]]
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_admin_of_another_chat_cannot_revoke_this_chats_link():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    dave, dave_id = await _register_user()
    try:
        chat_a = await _group_with(alice, bob_id, title="Chat A")
        link = await _create_link(alice, chat_a)

        chat_b = await _group_with(carol, dave_id, title="Chat B")
        # carol is OWNER of chat_b, but not of chat_a — must not be able to revoke chat_a's link.
        r = await carol.post(f"/invite-links/{link['token']}/revoke")
        assert r.status_code == 403, r.text

        # The link must still be usable/listable from chat_a's side afterwards.
        r = await alice.get(f"/chats/{chat_a}/invite-links")
        assert link["token"] in [entry["token"] for entry in r.json()["data"]]
    finally:
        for c in (alice, bob, carol, dave):
            await c.aclose()


async def test_private_chat_rejects_invite_link_creation():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        r = await alice.post("/chats/private", json={"target_user_id": str(bob_id)})
        assert r.status_code == 200, r.text
        chat_id = r.json()["data"]["id"]

        r = await alice.post(f"/chats/{chat_id}/invite-links", json={})
        assert r.status_code == 400, r.text
        assert r.json()["error_code"] == "INVALID_CHAT_TYPE"
    finally:
        await alice.aclose()
        await bob.aclose()


# --------------------------------------------------------------------------------------------
# Preview
# --------------------------------------------------------------------------------------------


async def test_preview_exposes_summary_but_not_the_roster():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id, title="Preview Group")
        link = await _create_link(alice, chat_id)

        r = await carol.get(f"/invite-links/{link['token']}")
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["title"] == "Preview Group"
        assert data["chat_type"] == "group"
        assert data["member_count"] == 2
        assert "participants" not in data
        assert "members" not in data
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_preview_rejects_unknown_token_with_404():
    alice, alice_id = await _register_user()
    try:
        r = await alice.get(f"/invite-links/{uuid.uuid4().hex}")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()


async def test_preview_rejects_revoked_token_with_410():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id)

        r = await alice.post(f"/invite-links/{link['token']}/revoke")
        assert r.status_code == 200, r.text

        r = await carol.get(f"/invite-links/{link['token']}")
        assert r.status_code == 410, r.text
        assert r.json()["error_code"] == "INVITE_LINK_GONE"
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


# --------------------------------------------------------------------------------------------
# Join
# --------------------------------------------------------------------------------------------


async def test_join_adds_participant_and_bumps_use_count():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id)

        r = await carol.post(f"/invite-links/{link['token']}/join")
        assert r.status_code == 200, r.text
        body = r.json()["data"]
        assert body["chat_id"] == str(chat_id)
        assert body["already_member"] is False

        r = await alice.get(f"/chats/{chat_id}")
        assert r.status_code == 200, r.text
        member_ids = {p["user_id"] for p in r.json()["data"]["participants"]}
        assert str(carol_id) in member_ids

        r = await alice.get(f"/chats/{chat_id}/invite-links")
        [entry] = [
            e for e in r.json()["data"] if e["token"] == link["token"]
        ]
        assert entry["use_count"] == 1
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_join_triggers_epoch_rotation_for_encrypted_chats():
    """Joining through a link must open a new epoch exactly like `add-participants` does — the
    invite-link join path calls `chat_services.add_chat_participants` rather than a second,
    divergent insertion path, and that function is what triggers rotation."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)

        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 200, r.text
        epoch_before = r.json()["data"]["epoch"]

        link = await _create_link(alice, chat_id)
        r = await carol.post(f"/invite-links/{link['token']}/join")
        assert r.status_code == 200, r.text

        r = await alice.get(f"/crypto/chats/{chat_id}/roster")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["current_epoch"] > epoch_before
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_already_member_join_is_a_noop_and_does_not_consume_a_use():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id, max_uses=1)

        # bob is already a member — following the link must be a harmless no-op.
        r = await bob.post(f"/invite-links/{link['token']}/join")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["already_member"] is True

        r = await alice.get(f"/chats/{chat_id}/invite-links")
        [entry] = [e for e in r.json()["data"] if e["token"] == link["token"]]
        assert entry["use_count"] == 0  # not consumed
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_join_rejects_exhausted_link():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    dave, dave_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id, max_uses=1)

        r = await carol.post(f"/invite-links/{link['token']}/join")
        assert r.status_code == 200, r.text

        r = await dave.post(f"/invite-links/{link['token']}/join")
        assert r.status_code == 410, r.text
        assert r.json()["error_code"] == "INVITE_LINK_GONE"

        r = await alice.get(f"/chats/{chat_id}")
        member_ids = {p["user_id"] for p in r.json()["data"]["participants"]}
        assert str(dave_id) not in member_ids
    finally:
        for c in (alice, bob, carol, dave):
            await c.aclose()


async def test_join_rejects_expired_link():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(
            alice, chat_id, expires_at="2000-01-01T00:00:00Z"
        )

        r = await carol.post(f"/invite-links/{link['token']}/join")
        assert r.status_code == 410, r.text
        assert r.json()["error_code"] == "INVITE_LINK_GONE"
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_join_rejects_revoked_link():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id)

        r = await alice.post(f"/invite-links/{link['token']}/revoke")
        assert r.status_code == 200, r.text

        r = await carol.post(f"/invite-links/{link['token']}/join")
        assert r.status_code == 410, r.text
    finally:
        for c in (alice, bob, carol):
            await c.aclose()


async def test_join_rejects_unknown_token():
    alice, alice_id = await _register_user()
    try:
        r = await alice.post(f"/invite-links/{uuid.uuid4().hex}/join")
        assert r.status_code == 404, r.text
    finally:
        await alice.aclose()


async def test_concurrent_joins_on_single_use_remaining_link_only_one_succeeds():
    """`max_uses=1`, two joiners racing: at most one must be added and `use_count` must end at 1,
    not 2. Guards against the read-then-write shape of the race this codebase already fixed once
    for the encrypted-group member cap."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    dave, dave_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)
        link = await _create_link(alice, chat_id, max_uses=1)

        results = await asyncio.gather(
            carol.post(f"/invite-links/{link['token']}/join"),
            dave.post(f"/invite-links/{link['token']}/join"),
        )
        statuses = sorted(r.status_code for r in results)
        assert statuses == [200, 410]

        r = await alice.get(f"/chats/{chat_id}/invite-links")
        # The link is exhausted, so it no longer shows up in the active listing at all — confirm
        # via the chat roster and a direct preview instead.
        active_tokens = [e["token"] for e in r.json()["data"]]
        assert link["token"] not in active_tokens

        r = await alice.get(f"/chats/{chat_id}")
        member_ids = {p["user_id"] for p in r.json()["data"]["participants"]}
        joined = {str(carol_id), str(dave_id)} & member_ids
        assert len(joined) == 1
    finally:
        for c in (alice, bob, carol, dave):
            await c.aclose()


# --------------------------------------------------------------------------------------------
# Rate limiting on list — same pattern as `test_new_rate_limits.py`: the integration suite runs
# with `RATE_LIMIT_ENABLED=false`, so this exercises the exact scope/limit/window
# `list_invite_links` calls `enforce_rate_limit` with directly against Redis, rather than driving
# it through a live HTTP request against the (limiter-disabled) server.
# --------------------------------------------------------------------------------------------


@pytest.fixture
async def redis():
    client = Redis.from_url(app_settings.REDIS_URL, decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


async def test_list_invite_links_scope_allows_up_to_the_limit_then_refuses(redis):
    original = app_settings.RATE_LIMIT_ENABLED
    app_settings.RATE_LIMIT_ENABLED = True
    try:
        identifier = uuid.uuid4().hex

        for _ in range(INVITE_LIST_LIMIT):
            await enforce_rate_limit(
                redis,
                scope="invite-link-list",
                identifier=identifier,
                limit=INVITE_LIST_LIMIT,
                window_seconds=INVITE_LIST_WINDOW,
            )

        with pytest.raises(AppException) as excinfo:
            await enforce_rate_limit(
                redis,
                scope="invite-link-list",
                identifier=identifier,
                limit=INVITE_LIST_LIMIT,
                window_seconds=INVITE_LIST_WINDOW,
            )

        assert excinfo.value.status_code == 429
        assert excinfo.value.error_code == "RATE_LIMITED"
    finally:
        app_settings.RATE_LIMIT_ENABLED = original


# --------------------------------------------------------------------------------------------
# Member cap — in-process, monkeypatched, same reasoning as test_group_cap.py
# --------------------------------------------------------------------------------------------


async def test_join_is_rejected_once_the_encrypted_cap_would_be_exceeded(monkeypatch):
    monkeypatch.setattr(epoch_service, "MAX_E2E_GROUP_MEMBERS", 2)

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)  # already at the patched cap of 2

        async with _session() as db:
            link = await invite_link_services.create_invite_link(
                db, chat_id, alice_id, None, None
            )

        r = await alice.post("/crypto/chats/" + str(chat_id) + "/enable")
        assert r.status_code == 200, r.text

        async with _session() as db:
            with pytest.raises(AppException) as excinfo:
                await invite_link_services.join_via_invite_link(
                    db, None, link.token, carol_id
                )
        assert excinfo.value.error_code == "GROUP_TOO_LARGE"

        # The rejected attempt must not have partially applied: no membership row, no consumed
        # use — both would have committed together with the (never-reached) participant insert.
        async with _session() as db:
            member_ids = await chat_services.get_chat_participants_ids(db, chat_id)
            refreshed = await invite_link_services.get_invite_link_by_token(
                db, link.token
            )
        assert carol_id not in member_ids
        assert refreshed.use_count == 0
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_join_below_cap_still_succeeds_via_service(monkeypatch):
    monkeypatch.setattr(epoch_service, "MAX_E2E_GROUP_MEMBERS", 3)

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)  # 2 members already

        r = await alice.post("/crypto/chats/" + str(chat_id) + "/enable")
        assert r.status_code == 200, r.text

        async with _session() as db:
            link = await invite_link_services.create_invite_link(
                db, chat_id, alice_id, None, None
            )

        async with _session() as db:
            chat_id_out, already_member, epoch = (
                await invite_link_services.join_via_invite_link(
                    db, None, link.token, carol_id
                )
            )
        assert chat_id_out == chat_id
        assert already_member is False
        assert epoch is not None

        async with _session() as db:
            member_ids = await chat_services.get_chat_participants_ids(db, chat_id)
        assert carol_id in member_ids
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()
