import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CHAR, Text, Integer, Boolean, DateTime, Enum, ForeignKey, func, text, UniqueConstraint, Index,
    CheckConstraint,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.postgres import Base


class IdentityKeyAlgorithm(str, enum.Enum):
    X25519_ED25519_V1 = "x25519_ed25519_v1"


class UserIdentityKey(Base):
    """A device's published public keys plus its password-wrapped private bundle.

    The server stores the wrapped bundle but can never open it: the wrapping key is derived from
    the user's password client-side with Argon2id. That also means a database disclosure hands an
    attacker an offline guessing target, which is why the Argon2 parameters in `kdf_params` are a
    security control rather than a detail.

    Superseded keys are kept with is_active=False and revoked_at set, so a key change is an
    auditable event rather than a silent overwrite (the current RSA flow overwrites in place,
    which is precisely the MITM opening this replaces).
    """
    __tablename__ = "user_identity_keys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_devices.id", ondelete="CASCADE"), nullable=False, index=True
    )

    algorithm: Mapped[IdentityKeyAlgorithm] = mapped_column(
        Enum(IdentityKeyAlgorithm), default=IdentityKeyAlgorithm.X25519_ED25519_V1, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # base64url, unpadded, 32 raw bytes each.
    # Fixed width (43 chars = 32 bytes, 86 chars = 64 bytes), enforced by the column type and by
    # CHECK constraints below: bpchar would silently pad a short value, the CHECK rejects it.
    identity_public_key: Mapped[str] = mapped_column(CHAR(43), nullable=False)   # X25519, key agreement
    signing_public_key: Mapped[str] = mapped_column(CHAR(43), nullable=False)    # Ed25519, signatures
    # Ed25519 over DS_IDENTITY_BIND || user_id || device_id || identity_public_key.
    # Verified server-side on publish; proves both keys belong to the same identity.
    identity_key_signature: Mapped[str] = mapped_column(CHAR(86), nullable=False)

    # Medium-term prekey, rotated ~weekly. Gives forward secrecy for key wrapping without the
    # inventory/refill/exhaustion machinery that one-time prekeys (full X3DH) would require.
    signed_prekey_public: Mapped[str | None] = mapped_column(CHAR(43), nullable=True)
    signed_prekey_signature: Mapped[str | None] = mapped_column(CHAR(86), nullable=True)
    signed_prekey_created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    encrypted_private_bundle: Mapped[str] = mapped_column(Text, nullable=False)
    # {"kdf":"argon2id","m":...,"t":...,"p":...,"salt":"<b64u>","nonce":"<b64u>"}
    # Stored so the client can reproduce the KEK, and so parameters can be raised later without
    # invalidating blobs wrapped under the old ones.
    kdf_params: Mapped[dict] = mapped_column(JSONB, nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    device = relationship("UserDevice")

    __table_args__ = (
        CheckConstraint("length(identity_public_key) = 43", name="ck_identity_key_identity_public_len"),
        CheckConstraint("length(signing_public_key) = 43", name="ck_identity_key_signing_public_len"),
        CheckConstraint("length(identity_key_signature) = 86", name="ck_identity_key_signature_len"),
        CheckConstraint(
            "signed_prekey_public IS NULL OR length(signed_prekey_public) = 43",
            name="ck_identity_key_prekey_public_len",
        ),
        CheckConstraint(
            "signed_prekey_signature IS NULL OR length(signed_prekey_signature) = 86",
            name="ck_identity_key_prekey_signature_len",
        ),
        UniqueConstraint("device_id", "version", name="uq_identity_key_device_version"),
        # At most one active key per device, enforced by the database rather than by convention.
        # Partial unique index: superseded rows (is_active=False) are retained for audit.
        Index(
            "uq_identity_key_active_per_device",
            "device_id",
            unique=True,
            postgresql_where=text("is_active"),
        ),
    )
