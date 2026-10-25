"""The schema-hardening migrations, run for real against a scratch database.

A throwaway database is created on the same server, migrated to the revision before TB-21, seeded
with rows that violate the new constraints, and then upgraded: the migration has to abort naming the
offenders and leave the schema untouched. After the rows are repaired the full
upgrade / downgrade / upgrade cycle has to work, and the models must match the result.
"""
import asyncio
import os
import subprocess
import sys
import uuid
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings as app_settings

API_DIR = Path(__file__).resolve().parents[2]
BEFORE_HARDENING = "f7af24530412"


def _alembic(database_url: str, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "DATABASE_URL": database_url}
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=API_DIR, env=env, capture_output=True, text=True, timeout=300,
    )


async def test_seeded_violations_abort_the_upgrade_then_the_full_cycle_works():
    scratch = f"migtest_{uuid.uuid4().hex[:12]}"
    base = make_url(app_settings.DATABASE_URL)
    admin = create_async_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    scratch_url = base.set(database=scratch).render_as_string(hide_password=False)

    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{scratch}"'))

        run = lambda *a: asyncio.to_thread(_alembic, scratch_url, *a)  # noqa: E731

        result = await run("upgrade", BEFORE_HARDENING)
        assert result.returncode == 0, result.stderr[-2000:]

        user_id, device_id, key_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        chat_id, epoch_id = uuid.uuid4(), uuid.uuid4()
        engine = create_async_engine(scratch_url)
        async with engine.begin() as conn:
            await conn.execute(text(
                "INSERT INTO users (id, full_name, username, phone_number, hashed_password, email, "
                "is_verified, public_key, encrypted_private_key, is_active) VALUES "
                "(:u, 'n', :name, '+380500000000', 'h', 'm@example.com', true, 'k', 'k', true)"
            ), {"u": user_id, "name": f"user_{uuid.uuid4().hex[:8]}"})
            await conn.execute(text(
                "INSERT INTO user_devices (id, user_id, display_name, is_active) VALUES (:d, :u, 'x', true)"
            ), {"d": device_id, "u": user_id})
            await conn.execute(text(
                "INSERT INTO user_identity_keys (id, user_id, device_id, algorithm, version, "
                "identity_public_key, signing_public_key, identity_key_signature, signed_prekey_public, "
                "encrypted_private_bundle, kdf_params, is_active) VALUES (:k, :u, :d, "
                "'X25519_ED25519_V1', 1, :pub, :pub, :sig, 'short', 'b', '{}', true)"
            ), {"k": key_id, "u": user_id, "d": device_id, "pub": "A" * 43, "sig": "B" * 86})
            await conn.execute(text(
                "INSERT INTO chats (id, chat_type) VALUES (:c, 'GROUP')"
            ), {"c": chat_id})
            await conn.execute(text(
                "INSERT INTO chat_key_epochs (id, chat_id, epoch, reason, member_count, member_set_hash) "
                "VALUES (:e, :c, 1, 'INITIAL', 1, 'NOT-A-HASH')"
            ), {"e": epoch_id, "c": chat_id})

        # --- the upgrade refuses, names the offenders, and changes nothing ----------------------
        result = await run("upgrade", "head")
        output = result.stdout + result.stderr
        assert result.returncode != 0
        assert "aborted" in output
        assert str(key_id) in output and "signed_prekey_public" in output
        assert str(epoch_id) in output and "member_set_hash" in output

        current = await run("current")
        assert BEFORE_HARDENING in current.stdout + current.stderr

        # --- repaired data: the whole chain applies, reverses and re-applies --------------------
        async with engine.begin() as conn:
            await conn.execute(text(
                "UPDATE user_identity_keys SET signed_prekey_public = NULL WHERE id = :k"
            ), {"k": key_id})
            await conn.execute(text(
                "UPDATE chat_key_epochs SET member_set_hash = :h WHERE id = :e"
            ), {"h": "a" * 64, "e": epoch_id})
        await engine.dispose()

        for args in (("upgrade", "head"), ("downgrade", BEFORE_HARDENING), ("upgrade", "head")):
            result = await run(*args)
            assert result.returncode == 0, f"{args}: {(result.stdout + result.stderr)[-2000:]}"

        result = await run("check")
        assert result.returncode == 0, (result.stdout + result.stderr)[-2000:]
    finally:
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)'))
        await admin.dispose()
