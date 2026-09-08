import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.domains.crypto.reference.primitives import b64u_decode

RAW_KEY_BYTES = 32
SIGNATURE_BYTES = 64


def _b64u_of_length(value: str, expected: int, label: str) -> str:
    try:
        raw = b64u_decode(value)
    except Exception:
        raise ValueError(f"{label} must be valid unpadded base64url")

    if len(raw) != expected:
        raise ValueError(f"{label} must decode to {expected} bytes, got {len(raw)}")

    return value


class IdentityPublishRequest(BaseModel):
    """Publish or rotate a device's identity.

    The server validates structure and verifies `identity_key_signature` before storing. It
    cannot validate the private bundle — that is opaque by design — but rejecting malformed
    public keys at the door prevents a whole class of permanently-broken accounts.
    """
    device_id: uuid.UUID
    display_name: str = Field("default", max_length=100)

    identity_public_key: str   # X25519
    signing_public_key: str    # Ed25519
    identity_key_signature: str

    signed_prekey_public: str | None = None
    signed_prekey_signature: str | None = None

    encrypted_private_bundle: str
    kdf_params: dict

    @field_validator("identity_public_key")
    @classmethod
    def _v_identity(cls, v: str) -> str:
        return _b64u_of_length(v, RAW_KEY_BYTES, "identity_public_key")

    @field_validator("signing_public_key")
    @classmethod
    def _v_signing(cls, v: str) -> str:
        return _b64u_of_length(v, RAW_KEY_BYTES, "signing_public_key")

    @field_validator("identity_key_signature")
    @classmethod
    def _v_sig(cls, v: str) -> str:
        return _b64u_of_length(v, SIGNATURE_BYTES, "identity_key_signature")

    @field_validator("signed_prekey_public")
    @classmethod
    def _v_prekey(cls, v: str | None) -> str | None:
        return v if v is None else _b64u_of_length(v, RAW_KEY_BYTES, "signed_prekey_public")

    @field_validator("kdf_params")
    @classmethod
    def _v_kdf(cls, v: dict) -> dict:
        # Pin the KDF so a client cannot downgrade itself to a weak or absent derivation.
        if v.get("kdf") != "argon2id":
            raise ValueError("kdf must be 'argon2id'")

        for field in ("m", "t", "p", "salt", "nonce"):
            if field not in v:
                raise ValueError(f"kdf_params missing '{field}'")

        if int(v["m"]) < 19456 or int(v["t"]) < 2:
            raise ValueError("argon2id parameters below minimum (m>=19456 KiB, t>=2)")

        return v


class PrekeyRotateRequest(BaseModel):
    device_id: uuid.UUID
    signed_prekey_public: str
    signed_prekey_signature: str

    @field_validator("signed_prekey_public")
    @classmethod
    def _v_prekey(cls, v: str) -> str:
        return _b64u_of_length(v, RAW_KEY_BYTES, "signed_prekey_public")

    @field_validator("signed_prekey_signature")
    @classmethod
    def _v_prekey_sig(cls, v: str) -> str:
        return _b64u_of_length(v, SIGNATURE_BYTES, "signed_prekey_signature")


class RewrappedIdentity(BaseModel):
    """A private bundle re-wrapped under a new password, with the SAME keypair.

    This is what makes "change password" non-destructive: only the wrapping changes, so every
    message and key grant the user could read before, they can still read.
    """
    device_id: uuid.UUID
    encrypted_private_bundle: str
    kdf_params: dict

    @field_validator("kdf_params")
    @classmethod
    def _v_kdf(cls, v: dict) -> dict:
        if v.get("kdf") != "argon2id":
            raise ValueError("kdf must be 'argon2id'")

        for field in ("m", "t", "p", "salt", "nonce"):
            if field not in v:
                raise ValueError(f"kdf_params missing '{field}'")

        if int(v["m"]) < 19456 or int(v["t"]) < 2:
            raise ValueError("argon2id parameters below minimum (m>=19456 KiB, t>=2)")

        return v


class PublicKeyResponse(BaseModel):
    """A peer's public key material. Never includes the wrapped private bundle."""
    user_id: uuid.UUID
    device_id: uuid.UUID
    # Exposed under a clearer name than the bare `id` the ORM object carries.
    identity_key_id: uuid.UUID = Field(validation_alias="id")
    version: int

    identity_public_key: str
    signing_public_key: str
    identity_key_signature: str
    signed_prekey_public: str | None = None
    signed_prekey_signature: str | None = None

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class OwnIdentityResponse(PublicKeyResponse):
    """Own key material, including the wrapped private bundle needed to unlock after login."""
    encrypted_private_bundle: str
    kdf_params: dict
    created_at: datetime
    # Exposed only on the owner's own view so the client can tell when its prekey is due for
    # rotation. Absent from PublicKeyResponse: when a peer's prekey was minted is nobody else's
    # business, and it would leak device activity.
    signed_prekey_created_at: datetime | None = None


class UserKeysRequest(BaseModel):
    user_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=512)


class SafetyNumberResponse(BaseModel):
    """Out-of-band verification fingerprint. Both peers must see the same value."""
    user_id: uuid.UUID
    peer_user_id: uuid.UUID
    safety_number: str
