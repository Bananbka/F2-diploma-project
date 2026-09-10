import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppException
from app.domains.crypto.models import UserDevice, UserIdentityKey
from app.domains.crypto.reference.identity import (
    safety_number,
    user_fingerprint_material,
    verify_identity_binding,
    verify_signed_prekey,
)
from app.domains.crypto.reference.primitives import b64u_decode
from app.domains.crypto.schemas.crypto_schemas import IdentityPublishRequest, PrekeyRotateRequest

MAX_ACTIVE_DEVICES_PER_USER = 5


async def publish_identity(
        db: AsyncSession,
        user_id: uuid.UUID,
        data: IdentityPublishRequest,
) -> UserIdentityKey:
    """Register or rotate a device's identity keys.

    Rotation supersedes rather than overwrites: the previous key is kept with is_active=False so
    a key change is an auditable event. The old flow overwrote users.public_key in place, which
    is exactly what let a malicious server swap a key without anyone noticing.
    """
    # The server cannot read anything, but it CAN check that the signing key vouches for the
    # X25519 key under this user and device. Rejecting here prevents unusable accounts and blocks
    # a key pair being transplanted from another identity.
    if not verify_identity_binding(
            user_id,
            data.device_id,
            b64u_decode(data.identity_public_key),
            b64u_decode(data.signing_public_key),
            b64u_decode(data.identity_key_signature),
    ):
        raise AppException(
            400, "INVALID_KEY_SIGNATURE",
            "identity_key_signature does not verify for this user and device."
        )

    # A prekey published here was stored without its signature ever being checked — only the
    # rotation endpoint verified one. Grants prefer the prekey over the identity key as the ECDH
    # recipient, so an unverified prekey at registration is the same substitution that
    # `rotate_prekey` refuses, just through a different door.
    if data.signed_prekey_public is not None:
        if data.signed_prekey_signature is None:
            raise AppException(
                400, "PREKEY_SIGNATURE_REQUIRED",
                "A signed prekey must be accompanied by its binding signature.",
            )

        if not verify_signed_prekey(
                user_id=user_id,
                device_id=data.device_id,
                signed_prekey_public=b64u_decode(data.signed_prekey_public),
                signing_public=b64u_decode(data.signing_public_key),
                signature=b64u_decode(data.signed_prekey_signature),
        ):
            raise AppException(
                400, "INVALID_KEY_SIGNATURE",
                "The prekey signature does not verify for this user and device.",
            )

    device = await db.get(UserDevice, data.device_id)

    if device is None:
        # Bounded so one account cannot mint devices without limit. Each new device forces a key
        # rotation in every encrypted chat the user belongs to, and rotation makes every other
        # member re-wrap grants — so an unbounded device count is an amplification lever, not
        # just untidy bookkeeping.
        active_devices = await db.scalar(
            select(func.count())
            .select_from(UserDevice)
            .where(UserDevice.user_id == user_id, UserDevice.is_active.is_(True))
        )
        if active_devices >= MAX_ACTIVE_DEVICES_PER_USER:
            raise AppException(
                409, "TOO_MANY_DEVICES",
                f"An account may have at most {MAX_ACTIVE_DEVICES_PER_USER} active devices. "
                f"Revoke one before registering another.",
            )

        device = UserDevice(
            id=data.device_id,
            user_id=user_id,
            display_name=data.display_name,
        )
        db.add(device)
        await db.flush()
    elif device.user_id != user_id:
        raise AppException(409, "DEVICE_CONFLICT", "This device id belongs to another user.")
    elif not device.is_active:
        # Re-activating rather than silently attaching a key to a revoked device, whose keys the
        # roster query filters out — the account would look published and never receive a grant.
        device.is_active = True
        device.revoked_at = None

    prev_stmt = (
        select(UserIdentityKey)
        .where(UserIdentityKey.device_id == device.id, UserIdentityKey.is_active.is_(True))
    )
    previous = (await db.execute(prev_stmt)).scalar_one_or_none()

    next_version = 1
    if previous is not None:
        next_version = previous.version + 1
        previous.is_active = False
        previous.revoked_at = datetime.now(timezone.utc)
        # Release the partial unique index before inserting the replacement.
        await db.flush()

    now = datetime.now(timezone.utc)
    key = UserIdentityKey(
        user_id=user_id,
        device_id=device.id,
        version=next_version,
        identity_public_key=data.identity_public_key,
        signing_public_key=data.signing_public_key,
        identity_key_signature=data.identity_key_signature,
        signed_prekey_public=data.signed_prekey_public,
        signed_prekey_signature=data.signed_prekey_signature,
        signed_prekey_created_at=now if data.signed_prekey_public else None,
        encrypted_private_bundle=data.encrypted_private_bundle,
        kdf_params=data.kdf_params,
    )
    db.add(key)

    await db.commit()
    await db.refresh(key)
    return key


async def rotate_prekey(
        db: AsyncSession,
        user_id: uuid.UUID,
        data: PrekeyRotateRequest,
) -> UserIdentityKey:
    """Rotate only the medium-term prekey. Does not supersede the identity key or void grants."""
    key = await get_active_key_for_device(db, data.device_id)

    if key is None or key.user_id != user_id:
        raise AppException(404, "DEVICE_NOT_FOUND", "No active identity key for this device.")

    # Grants prefer the signed prekey over the identity key as the ECDH recipient, so an unchecked
    # prekey would let anyone able to reach this endpoint swap in a key they hold and receive every
    # subsequent sender key. Checked against the device's *existing* signing key, which this request
    # cannot change — that is what makes the check meaningful rather than self-certifying.
    #
    # Only what is supplied here is verified. Rows written before this check existed hold signatures
    # that were never verifiable, and retroactively rejecting them would lock those devices out.
    if not verify_signed_prekey(
            user_id=user_id,
            device_id=data.device_id,
            signed_prekey_public=b64u_decode(data.signed_prekey_public),
            signing_public=b64u_decode(key.signing_public_key),
            signature=b64u_decode(data.signed_prekey_signature),
    ):
        raise AppException(
            400, "INVALID_KEY_SIGNATURE",
            "The prekey signature does not verify against this device's identity key.",
        )

    key.signed_prekey_public = data.signed_prekey_public
    key.signed_prekey_signature = data.signed_prekey_signature
    key.signed_prekey_created_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(key)
    return key


async def get_active_key_for_device(
        db: AsyncSession,
        device_id: uuid.UUID,
) -> UserIdentityKey | None:
    stmt = select(UserIdentityKey).where(
        UserIdentityKey.device_id == device_id,
        UserIdentityKey.is_active.is_(True),
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_active_keys_for_users(
        db: AsyncSession,
        user_ids: list[uuid.UUID],
) -> list[UserIdentityKey]:
    """Batch-fetch active public keys.

    This is the call a client makes before wrapping group keys, so it must be one query rather
    than N — there was no batch user fetch anywhere in the codebase before this.
    """
    if not user_ids:
        return []

    stmt = (
        select(UserIdentityKey)
        .join(UserDevice, UserDevice.id == UserIdentityKey.device_id)
        .where(
            UserIdentityKey.user_id.in_(user_ids),
            UserIdentityKey.is_active.is_(True),
            UserDevice.is_active.is_(True),
        )
    )
    return list((await db.execute(stmt)).scalars().all())


async def get_active_signing_keys(db: AsyncSession, user_id: uuid.UUID) -> list[UserIdentityKey]:
    """**All** of the user's active identity keys, for verifying something they signed.

    This used to return a single row with a bare `.limit(1)` and no ordering. The rest of the
    crypto layer is fully per-device — grants, rosters and epochs all are — so as soon as a user
    had two devices, a post signed on one was verified against whichever key Postgres happened to
    return, and valid posts were rejected at random. A signature only needs to match *one* of the
    keys the user has published.
    """
    stmt = (
        select(UserIdentityKey)
        .join(UserDevice, UserDevice.id == UserIdentityKey.device_id)
        .where(
            UserIdentityKey.user_id == user_id,
            UserIdentityKey.is_active.is_(True),
            UserDevice.is_active.is_(True),
        )
        .order_by(UserIdentityKey.device_id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def revoke_device(db: AsyncSession, user_id: uuid.UUID, device_id: uuid.UUID) -> None:
    """Revoke one of your own devices — a lost phone, a shared machine.

    There was no way to do this short of a full password reset, which destroys the identity and
    every message it can read. Revoking marks the device and its key inactive, which removes it
    from every chat roster; the caller is responsible for re-keying those chats so the revoked
    device receives no further grants.
    """
    device = await db.get(UserDevice, device_id)
    if device is None or device.user_id != user_id:
        raise AppException(404, "DEVICE_NOT_FOUND", "No such device on this account.")

    if not device.is_active:
        raise AppException(409, "ALREADY_REVOKED", "This device is already revoked.")

    remaining = await db.scalar(
        select(func.count())
        .select_from(UserDevice)
        .where(
            UserDevice.user_id == user_id,
            UserDevice.is_active.is_(True),
            UserDevice.id != device_id,
        )
    )
    if not remaining:
        # Revoking the last device leaves an account that can decrypt nothing and cannot publish
        # a replacement without a fresh identity, which is the password-reset path, not this one.
        raise AppException(
            409, "LAST_DEVICE",
            "You cannot revoke your only device. Register another one first.",
        )

    now = datetime.now(timezone.utc)

    await db.execute(
        update(UserIdentityKey)
        .where(UserIdentityKey.device_id == device_id, UserIdentityKey.is_active.is_(True))
        .values(is_active=False, revoked_at=now)
    )
    device.is_active = False
    device.revoked_at = now

    await db.flush()


async def get_own_identities(db: AsyncSession, user_id: uuid.UUID) -> list[UserIdentityKey]:
    stmt = select(UserIdentityKey).where(
        UserIdentityKey.user_id == user_id,
        UserIdentityKey.is_active.is_(True),
    )
    return list((await db.execute(stmt)).scalars().all())


async def compute_safety_number(
        db: AsyncSession,
        user_id: uuid.UUID,
        peer_user_id: uuid.UUID,
) -> str:
    """Fingerprint for out-of-band comparison between two users.

    The server computing this is a convenience only — a malicious server could lie. The value is
    meaningful precisely because both users compare it through a channel the server does not
    control, so the client must be able to derive it independently.
    """
    if user_id == peer_user_id:
        raise AppException(400, "INVALID_TARGET", "Cannot compute a safety number with yourself.")

    keys = await get_active_keys_for_users(db, [user_id, peer_user_id])

    mine = [b64u_decode(k.signing_public_key) for k in keys if k.user_id == user_id]
    theirs = [b64u_decode(k.signing_public_key) for k in keys if k.user_id == peer_user_id]

    if not mine:
        raise AppException(400, "NO_IDENTITY_KEY", "You have not published an identity key.")
    if not theirs:
        raise AppException(404, "PEER_NO_IDENTITY_KEY", "This user has not published an identity key.")

    # Every active device on each side contributes. Picking one key per user made the value
    # depend on row ordering and left it unchanged when a peer added a device — so a new device
    # (including one the server planted) would not have shown up as a key change.
    return safety_number(
        user_fingerprint_material(mine),
        user_fingerprint_material(theirs),
    )


async def rewrap_private_bundles(
        db: AsyncSession,
        user_id: uuid.UUID,
        items: list,
) -> int:
    """Re-wrap private bundles under a new password, keeping the keypairs intact.

    Used by change-password. Deliberately does NOT touch the public keys or bump the version:
    nothing about the identity has changed, only the password protecting it locally. Rotating the
    keypair here would orphan every message and key grant the user can currently decrypt.
    """
    if not items:
        return 0

    by_device = {item.device_id: item for item in items}

    stmt = select(UserIdentityKey).where(
        UserIdentityKey.user_id == user_id,
        UserIdentityKey.device_id.in_(list(by_device.keys())),
        UserIdentityKey.is_active.is_(True),
    )
    keys = list((await db.execute(stmt)).scalars().all())

    if len(keys) != len(by_device):
        raise AppException(
            400, "UNKNOWN_DEVICE",
            "One or more device ids do not have an active identity key for this user."
        )

    for key in keys:
        item = by_device[key.device_id]
        key.encrypted_private_bundle = item.encrypted_private_bundle
        key.kdf_params = item.kdf_params

    # Caller owns the commit: this runs inside the same transaction as the password change, so a
    # failure must not leave the password updated but the bundles wrapped under the old one.
    await db.flush()
    return len(keys)


async def deactivate_user_devices(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Revoke every device for a user. Used by the password-reset path, where the private bundle
    becomes permanently unrecoverable and the old identity is therefore dead."""
    now = datetime.now(timezone.utc)

    await db.execute(
        update(UserIdentityKey)
        .where(UserIdentityKey.user_id == user_id, UserIdentityKey.is_active.is_(True))
        .values(is_active=False, revoked_at=now)
    )
    res = await db.execute(
        update(UserDevice)
        .where(UserDevice.user_id == user_id, UserDevice.is_active.is_(True))
        .values(is_active=False, revoked_at=now)
    )

    # Caller owns the commit so this lands atomically with the password change.
    await db.flush()
    return res.rowcount
