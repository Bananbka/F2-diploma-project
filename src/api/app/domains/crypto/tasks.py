"""Scheduled key maintenance.

Follows the pattern in app/domains/files/tasks.py: a sync @shared_task wrapping asyncio.run with
its own engine, since Celery workers do not share the app's event loop.
"""
import asyncio
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings as app_settings
# Imported for their side effect on the SQLAlchemy registry. The crypto models declare
# relationship("User") and relationship("Chat") by name, and a Celery worker does not go through
# app.main, so without these the mapper cannot resolve those strings and every query fails.
from app.domains.chats.models import Chat, ChatParticipant  # noqa: F401
from app.domains.users.models import User  # noqa: F401
from app.domains.crypto.models import (
    ChatCryptoSettings,
    ChatKeyEpoch,
    CryptoMode,
    EpochReason,
    SenderKeyDistribution,
    SenderKeyGrant,
)
from app.domains.crypto.services import epoch_service

# Grants for long-closed epochs are dead weight once every recipient has fetched them. Kept for a
# grace period so a client that has been offline can still catch up.
GRANT_RETENTION_DAYS = 30


def _session_factory():
    engine = create_async_engine(app_settings.DATABASE_URL)
    return engine, async_sessionmaker(bind=engine, expire_on_commit=False)


async def _rotate_stale_epochs() -> int:
    engine, Session = _session_factory()
    rotated = 0

    try:
        async with Session() as db:
            now = datetime.now(timezone.utc)

            stmt = select(ChatCryptoSettings).where(
                ChatCryptoSettings.crypto_mode == CryptoMode.SENDER_KEYS_V1
            )
            for settings in (await db.execute(stmt)).scalars().all():
                interval = timedelta(days=settings.rotation_interval_days)
                last = settings.last_rotated_at

                if last is not None and now - last < interval:
                    continue

                # Skip chats with no traffic since the last rotation. Rotating a dormant chat just
                # creates epochs nobody will ever publish keys for, and every member would then be
                # nagged to do work for a conversation that is not happening.
                active = await db.scalar(
                    select(func.count())
                    .select_from(SenderKeyDistribution)
                    .join(ChatKeyEpoch, ChatKeyEpoch.id == SenderKeyDistribution.epoch_id)
                    .where(
                        SenderKeyDistribution.chat_id == settings.chat_id,
                        ChatKeyEpoch.epoch == settings.current_epoch,
                    )
                )
                if not active:
                    continue

                await epoch_service.allocate_epoch(
                    db, settings.chat_id, EpochReason.PERIODIC
                )
                await db.commit()
                rotated += 1
    finally:
        await engine.dispose()

    return rotated


async def _prune_delivered_grants() -> int:
    """Drop grants for long-closed epochs once every recipient has fetched them.

    Bounds growth of the quadratic table. Safe because a client that never fetched and has since
    lost its key could not decrypt these anyway. Distributions are never pruned — they hold the
    signing keys needed to verify historical message signatures.
    """
    engine, Session = _session_factory()

    try:
        async with Session() as db:
            cutoff = datetime.now(timezone.utc) - timedelta(days=GRANT_RETENTION_DAYS)

            undelivered = (
                select(SenderKeyGrant.distribution_id)
                .where(SenderKeyGrant.delivered_at.is_(None))
                .distinct()
            )

            stale_distributions = (
                select(SenderKeyDistribution.id)
                .join(ChatKeyEpoch, ChatKeyEpoch.id == SenderKeyDistribution.epoch_id)
                .where(
                    ChatKeyEpoch.closed_at.is_not(None),
                    ChatKeyEpoch.closed_at < cutoff,
                    SenderKeyDistribution.id.not_in(undelivered),
                )
            )

            res = await db.execute(
                delete(SenderKeyGrant).where(
                    SenderKeyGrant.distribution_id.in_(stale_distributions)
                )
            )
            await db.commit()
            return res.rowcount
    finally:
        await engine.dispose()


@shared_task
def rotate_stale_epochs_task():
    count = asyncio.run(_rotate_stale_epochs())
    print(f"KEY ROTATION: opened {count} periodic epochs")
    return count


@shared_task
def prune_delivered_grants_task():
    count = asyncio.run(_prune_delivered_grants())
    print(f"KEY ROTATION: pruned {count} delivered grants")
    return count
