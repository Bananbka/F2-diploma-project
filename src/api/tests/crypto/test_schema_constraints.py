"""Database-level constraints added by the schema-hardening migrations (TB-21, 22, 23, 25).

These talk to Postgres directly: the point is that the database refuses the bad row even when the
application layer would have let it through.
"""
import contextlib
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings as app_settings
from app.domains.crypto.reference.primitives import b64u_encode

from tests.crypto.test_epoch_api import _group_with, _publish_identity
from tests.crypto.test_identity_api import _register_user
from tests.stickers.test_sticker_packs import _add_sticker, _create_pack, _upload_sticker_image

CHECK_FOR = {
    "last_read_message_id": "ck_participant_last_read_objectid",
    "history_start_message_id": "ck_participant_history_start_objectid",
}
KEY43 = "A" * 43
SIG86 = "B" * 86
HASH64 = "a" * 64


@contextlib.asynccontextmanager
async def _session():
    engine = create_async_engine(app_settings.DATABASE_URL)
    try:
        async with async_sessionmaker(bind=engine, expire_on_commit=False)() as db:
            yield db
    finally:
        await engine.dispose()


async def _violates(sql: str, params: dict | None = None, constraint: str | None = None) -> bool:
    """True when the database rejects the statement (nothing is committed).

    When `constraint` is given it must be the one named in the error, so a test cannot pass because
    some unrelated constraint happened to fire.
    """
    async with _session() as db:
        try:
            await db.execute(text(sql), params or {})
            await db.rollback()
            return False
        except DBAPIError as exc:
            await db.rollback()
            if constraint is not None:
                assert constraint in str(exc.orig), f"expected {constraint}, got: {exc.orig}"
            return True


async def _encrypted_group():
    alice, alice_id = await _register_user()
    bob, bob_id = await _register_user()
    alice_device, alice_keys = await _publish_identity(alice, alice_id)
    await _publish_identity(bob, bob_id)
    chat_id = await _group_with(alice, bob_id)
    r = await alice.post(f"/crypto/chats/{chat_id}/enable")
    assert r.status_code == 200, r.text
    return alice, alice_id, alice_device, alice_keys, bob, bob_id, chat_id


async def test_second_open_epoch_for_a_chat_is_rejected():
    alice, alice_id, _, _, bob, _, chat_id = await _encrypted_group()
    try:
        assert await _violates(
            "INSERT INTO chat_key_epochs (id, chat_id, epoch, reason, member_count, member_set_hash) "
            "VALUES (:id, :chat, 99, 'MANUAL', 2, :h)",
            {"id": uuid.uuid4(), "chat": chat_id, "h": HASH64},
            constraint="uq_open_epoch_per_chat"
        )
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_removal_rotation_still_yields_exactly_one_open_epoch():
    alice, alice_id, _, _, bob, _, chat_id = await _encrypted_group()
    try:
        r = await bob.post(f"/chats/{chat_id}/leave")
        assert r.status_code == 200, r.text

        async with _session() as db:
            open_count = (await db.execute(
                text("SELECT count(*) FROM chat_key_epochs WHERE chat_id = :c AND closed_at IS NULL"),
                {"c": chat_id},
            )).scalar()
        assert open_count == 1
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_distribution_cannot_reference_another_chats_epoch():
    alice, alice_id, alice_device, alice_keys, bob, bob_id, chat_id = await _encrypted_group()
    other_chat = await _group_with(alice, bob_id, title="Other")
    try:
        r = await alice.post(f"/crypto/chats/{other_chat}/enable")
        assert r.status_code == 200, r.text
        async with _session() as db:
            epoch_id = (await db.execute(
                text("SELECT id FROM chat_key_epochs WHERE chat_id = :c"), {"c": chat_id}
            )).scalar()

        # chat_id says "other_chat", epoch_id belongs to chat_id: the composite FK refuses it.
        assert await _violates(
            "INSERT INTO sender_key_distributions (id, epoch_id, chat_id, sender_user_id, "
            "sender_device_id, sender_key_id, algorithm, signing_public_key, chain_start_index, signature) "
            "VALUES (:id, :e, :c, :u, :d, :k, 'x', :pk, 0, :sig)",
            {"id": uuid.uuid4(), "e": epoch_id, "c": other_chat, "u": alice_id,
             "d": alice_device, "k": uuid.uuid4(), "pk": KEY43, "sig": SIG86},
            constraint="fk_skd_epoch_chat"
        )
    finally:
        await alice.aclose()
        await bob.aclose()


IDENTITY_CHECKS = {
    "identity_public_key": "ck_identity_key_identity_public_len",
    "signing_public_key": "ck_identity_key_signing_public_len",
    "identity_key_signature": "ck_identity_key_signature_len",
    "signed_prekey_public": "ck_identity_key_prekey_public_len",
    "signed_prekey_signature": "ck_identity_key_prekey_signature_len",
}


@pytest.mark.parametrize(
    "column,value,expected",
    [
        ("identity_public_key", "A" * 42, "ck_identity_key_identity_public_len"),
        ("identity_public_key", "A" * 44, "value too long"),
        # 42 real characters plus a trailing space: char(43) would pad and accept it silently, but
        # length() ignores the pad, so the CHECK still sees 42.
        ("identity_public_key", "A" * 42 + " ", "ck_identity_key_identity_public_len"),
        ("signing_public_key", "A" * 42, "ck_identity_key_signing_public_len"),
        ("identity_key_signature", "B" * 85, "ck_identity_key_signature_len"),
        ("identity_key_signature", "B" * 85 + " ", "ck_identity_key_signature_len"),
        ("signed_prekey_public", "A" * 44, "value too long"),
        ("signed_prekey_public", "A" * 42 + " ", "ck_identity_key_prekey_public_len"),
        ("signed_prekey_signature", "B" * 87, "value too long"),
    ],
)
async def test_identity_key_columns_reject_wrong_lengths(column, value, expected):
    alice, alice_id = await _register_user()
    try:
        device_id = uuid.uuid4()
        values = {
            "identity_public_key": KEY43,
            "signing_public_key": KEY43,
            "identity_key_signature": SIG86,
            "signed_prekey_public": None,
            "signed_prekey_signature": None,
        }
        values[column] = value
        async with _session() as db:
            await db.execute(
                text("INSERT INTO user_devices (id, user_id, display_name, is_active) "
                     "VALUES (:d, :u, 'x', true)"),
                {"d": device_id, "u": alice_id},
            )
            error = None
            try:
                await db.execute(
                    text(
                        "INSERT INTO user_identity_keys (id, user_id, device_id, algorithm, version, "
                        "identity_public_key, signing_public_key, identity_key_signature, "
                        "signed_prekey_public, signed_prekey_signature, encrypted_private_bundle, "
                        "kdf_params, is_active) VALUES (:id, :u, :d, 'X25519_ED25519_V1', 1, :a, :b, :c, "
                        ":e, :f, 'x', '{}', false)"
                    ),
                    {"id": uuid.uuid4(), "u": alice_id, "d": device_id, "a": values["identity_public_key"],
                     "b": values["signing_public_key"], "c": values["identity_key_signature"],
                     "e": values["signed_prekey_public"], "f": values["signed_prekey_signature"]},
                )
            except DBAPIError as exc:
                error = str(exc.orig)
            await db.rollback()
        assert error is not None, f"{column} of length {len(value)} must be refused"
        assert expected in error, error
    finally:
        await alice.aclose()


@pytest.mark.parametrize("bad_hash", ["g" * 64, "A" * 64, "a" * 63])
async def test_member_set_hash_must_be_lowercase_hex_digest(bad_hash):
    alice, alice_id, _, _, bob, _, chat_id = await _encrypted_group()
    try:
        assert await _violates(
            "INSERT INTO chat_key_epochs (id, chat_id, epoch, reason, member_count, member_set_hash, closed_at) "
            "VALUES (:id, :chat, 98, 'MANUAL', 2, :h, now())",
            {"id": uuid.uuid4(), "chat": chat_id, "h": bad_hash},
            constraint="ck_chat_key_epochs_member_set_hash"
        )
    finally:
        await alice.aclose()
        await bob.aclose()


@pytest.mark.parametrize("column", ["last_read_message_id", "history_start_message_id"])
@pytest.mark.parametrize("bad", ["abc", "g" * 24, "A" * 24])
async def test_participant_object_id_columns_are_24_lowercase_hex(column, bad):
    alice, alice_id, _, _, bob, _, chat_id = await _encrypted_group()
    try:
        assert await _violates(
            f"UPDATE chat_participants SET {column} = :v WHERE chat_id = :c AND user_id = :u",
            {"v": bad, "c": chat_id, "u": alice_id},
            constraint=CHECK_FOR[column]
        )
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_contact_cannot_be_oneself():
    alice, alice_id = await _register_user()
    try:
        assert await _violates(
            "INSERT INTO contacts (owner_id, contact_id) VALUES (:u, :u)", {"u": alice_id},
            constraint="ck_contacts_not_self"
        )
    finally:
        await alice.aclose()


async def test_invite_link_use_count_cannot_exceed_max_uses():
    alice, alice_id, _, _, bob, _, chat_id = await _encrypted_group()
    try:
        assert await _violates(
            "INSERT INTO chat_invite_links (id, chat_id, created_by, token, max_uses, use_count) "
            "VALUES (:id, :c, :u, :t, 1, 2)",
            {"id": uuid.uuid4(), "c": chat_id, "u": alice_id, "t": uuid.uuid4().hex},
            constraint="ck_invite_links_use_count_le_max"
        )
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_sticker_positions_are_unique_per_pack_and_api_reports_conflicts():
    alice, alice_id = await _register_user()
    try:
        pack_id = await _create_pack(alice)
        first = await _add_sticker(alice, pack_id)
        second = await _add_sticker(alice, pack_id)
        assert (first["position"], second["position"]) == (0, 1)

        # The database refuses a duplicate outright...
        assert await _violates(
            "INSERT INTO stickers (id, pack_id, image_url, emoji, position) VALUES (:id, :p, 'u', 'x', 1)",
            {"id": uuid.uuid4(), "p": uuid.UUID(pack_id)},
            constraint="uq_stickers_pack_position"
        )

        # ...and the API turns an explicit clash into a 409 rather than a 500.
        image_url = await _upload_sticker_image(alice)
        r = await alice.post(
            f"/stickers/packs/{pack_id}/stickers",
            json={"image_url": image_url, "emoji": "x", "position": 1},
        )
        assert r.status_code == 409, r.text
        assert r.json()["error_code"] == "STICKER_POSITION_TAKEN"

        # Reordering swaps positions in place without tripping the unique constraint.
        r = await alice.put(
            f"/stickers/packs/{pack_id}/stickers/order", json=[second["id"], first["id"]]
        )
        assert r.status_code == 200, r.text
        pack = (await alice.get(f"/stickers/packs/{pack_id}")).json()["data"]
        assert [s["id"] for s in pack["stickers"]] == [second["id"], first["id"]]
    finally:
        await alice.aclose()


async def test_padded_public_key_is_rejected_with_422_not_500():
    """A padded spelling of a valid 32-byte key would be 44 chars and fail the CHECK; the schema
    must refuse it first."""
    alice, alice_id, alice_device, alice_keys, bob, _, chat_id = await _encrypted_group()
    try:
        r = await alice.post(
            f"/crypto/chats/{chat_id}/epochs/1/sender-keys",
            json={
                "sender_device_id": str(alice_device),
                "sender_key_id": str(uuid.uuid4()),
                "algorithm": "hkdf_sha256_aes256gcm_v1",
                "signing_public_key": b64u_encode(b"\x01" * 32) + "=",
                "chain_start_index": 0,
                "signature": b64u_encode(b"\x02" * 64),
                "grants": [{
                    "recipient_device_id": str(uuid.uuid4()),
                    "wrap_algorithm": "x25519_hkdf_sha256_aes256gcm_v1",
                    "ephemeral_public_key": b64u_encode(b"\x03" * 32),
                    "wrapped_chain_key": "x",
                }],
            },
        )
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()
        await bob.aclose()
