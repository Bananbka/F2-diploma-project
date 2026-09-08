"""Scheduled rotation and grant pruning."""
import uuid
from datetime import datetime, timedelta, timezone

import contextlib

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings as app_settings
from app.domains.crypto.models import ChatCryptoSettings, ChatKeyEpoch, SenderKeyGrant
from app.domains.crypto.tasks import _prune_delivered_grants, _rotate_stale_epochs

from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_identity_api import _register_user
from tests.crypto.test_rotation_api import _publish_chain


@contextlib.asynccontextmanager
async def _session():
    """A session on its own engine, disposed afterwards.

    pytest-asyncio gives each test a fresh event loop, so the app's module-level engine would hand
    back pooled connections bound to a previous loop and raise InterfaceError.
    """
    engine = create_async_engine(app_settings.DATABASE_URL)
    try:
        async with async_sessionmaker(bind=engine, expire_on_commit=False)() as db:
            yield db
    finally:
        await engine.dispose()


async def _backdate_rotation(chat_id: uuid.UUID, days: int):
    async with _session() as db:
        settings = (await db.execute(
            select(ChatCryptoSettings).where(ChatCryptoSettings.chat_id == chat_id)
        )).scalar_one()
        settings.last_rotated_at = datetime.now(timezone.utc) - timedelta(days=days)
        await db.commit()


async def _current_epoch(chat_id: uuid.UUID) -> int:
    async with _session() as db:
        return (await db.execute(
            select(ChatCryptoSettings.current_epoch).where(
                ChatCryptoSettings.chat_id == chat_id
            )
        )).scalar_one()


async def test_periodic_rotation_fires_once_the_interval_elapses():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")

        # The chat must have traffic in the current epoch, or rotation is skipped as dormant.
        await _publish_chain(alice, chat_id, 1, alice_id, alice_device, alice_keys)

        assert await _current_epoch(chat_id) == 1

        # Freshly rotated: nothing to do.
        await _rotate_stale_epochs()
        assert await _current_epoch(chat_id) == 1

        await _backdate_rotation(chat_id, days=45)  # default interval is 30 days

        assert await _rotate_stale_epochs() >= 1
        assert await _current_epoch(chat_id) == 2

        async with _session() as db:
            epochs = (await db.execute(
                select(ChatKeyEpoch)
                .where(ChatKeyEpoch.chat_id == chat_id)
                .order_by(ChatKeyEpoch.epoch)
            )).scalars().all()

        assert epochs[-1].reason.value == "periodic"
        assert epochs[0].closed_at is not None
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_dormant_chats_are_not_rotated():
    """Rotating a chat nobody uses just creates epochs no one will ever publish keys for."""
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")
        # No sender key published: the chat has never been used.

        await _backdate_rotation(chat_id, days=45)
        await _rotate_stale_epochs()

        assert await _current_epoch(chat_id) == 1, "a dormant chat must be left alone"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_pruning_keeps_undelivered_and_recent_grants():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    try:
        alice_device, alice_keys = await _publish_identity(alice, alice_id)
        await _publish_identity(bob, bob_id)

        chat_id = await _group_with(alice, bob_id)
        await alice.post(f"/crypto/chats/{chat_id}/enable")
        await _publish_chain(alice, chat_id, 1, alice_id, alice_device, alice_keys)

        async with _session() as db:
            before = len((await db.execute(
                select(SenderKeyGrant).where(SenderKeyGrant.chat_id == chat_id)
            )).scalars().all())
        assert before == 2

        # Epoch is still open and grants are undelivered, so nothing should go.
        await _prune_delivered_grants()

        async with _session() as db:
            after = len((await db.execute(
                select(SenderKeyGrant).where(SenderKeyGrant.chat_id == chat_id)
            )).scalars().all())

        assert after == before, "open epochs and undelivered grants must be retained"
    finally:
        await alice.aclose()
        await bob.aclose()
