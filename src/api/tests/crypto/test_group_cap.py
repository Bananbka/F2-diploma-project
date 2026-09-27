"""Encrypted-group member cap enforcement on `add_chat_participants`.

`enable_encryption` only checks `MAX_E2E_GROUP_MEMBERS` at the moment encryption is turned on;
nothing stopped an owner enabling it at a handful of members and then adding past the cap
afterwards. These tests call `chat_services.add_chat_participants` directly, in-process, rather
than through the HTTP router: the cap is read as `epoch_service.MAX_E2E_GROUP_MEMBERS` at call
time specifically so it can be monkeypatched here without registering the real 256 accounts the
production constant would otherwise require.
"""

import contextlib
import uuid

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings as app_settings
from app.core.exceptions import AppException
from app.domains.chats.services import chat_services
from app.domains.crypto.services import epoch_service

from tests.crypto.test_epoch_api import _group_with
from tests.crypto.test_identity_api import _register_user


@contextlib.asynccontextmanager
async def _session():
    """A session on its own engine, disposed afterwards.

    Same reasoning as `test_rotation_tasks.py`: pytest-asyncio gives each test a fresh event loop,
    so the app's module-level engine would hand back pooled connections bound to a previous loop.
    """
    engine = create_async_engine(app_settings.DATABASE_URL)
    try:
        async with async_sessionmaker(bind=engine, expire_on_commit=False)() as db:
            yield db
    finally:
        await engine.dispose()


async def test_add_participants_rejected_once_the_encrypted_cap_would_be_exceeded(
    monkeypatch,
):
    monkeypatch.setattr(epoch_service, "MAX_E2E_GROUP_MEMBERS", 3)

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    charlie, charlie_id = await _register_user()
    dave, dave_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)  # 2 members already

        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 200, r.text

        # Filling exactly up to the cap (2 -> 3) must still succeed.
        async with _session() as db:
            count, _ = await chat_services.add_chat_participants(
                db, chat_id, [charlie_id]
            )
        assert count == 1

        # One more (3 -> 4) must be rejected rather than silently exceeding the cap.
        async with _session() as db:
            with pytest.raises(AppException) as excinfo:
                await chat_services.add_chat_participants(db, chat_id, [dave_id])

        assert excinfo.value.status_code == 400
        assert excinfo.value.error_code == "GROUP_TOO_LARGE"
    finally:
        await alice.aclose()
        await bob.aclose()
        await charlie.aclose()
        await dave.aclose()


async def test_rejected_add_does_not_partially_apply(monkeypatch):
    monkeypatch.setattr(epoch_service, "MAX_E2E_GROUP_MEMBERS", 2)

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)  # already at the cap of 2
        r = await alice.post(f"/crypto/chats/{chat_id}/enable")
        assert r.status_code == 200, r.text

        async with _session() as db:
            with pytest.raises(AppException) as excinfo:
                await chat_services.add_chat_participants(db, chat_id, [carol_id])
        assert excinfo.value.error_code == "GROUP_TOO_LARGE"

        async with _session() as db:
            member_ids = await chat_services.get_chat_participants_ids(db, chat_id)
        assert carol_id not in member_ids
        assert len(member_ids) == 2
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()


async def test_non_encrypted_groups_are_not_capped(monkeypatch):
    """Only encrypted chats carry the cap; a plain group must never be blocked by it."""
    monkeypatch.setattr(epoch_service, "MAX_E2E_GROUP_MEMBERS", 1)

    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    carol, carol_id = await _register_user()
    try:
        chat_id = await _group_with(alice, bob_id)  # already exceeds the patched cap of 1

        async with _session() as db:
            count, epoch = await chat_services.add_chat_participants(
                db, chat_id, [carol_id]
            )
        assert count == 1
        assert epoch is None  # unencrypted chats never open an epoch
    finally:
        await alice.aclose()
        await bob.aclose()
        await carol.aclose()
