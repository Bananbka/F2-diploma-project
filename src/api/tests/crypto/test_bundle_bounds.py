"""Bounds on `encrypted_private_bundle` and `kdf_params`, added because both were previously
unbounded fields in a request body: `IdentityPublishRequest`/`RewrappedIdentity` used a bare
`str`/`dict` where every other key-shaped field in this module is length- or shape-checked.
"""

import uuid

import pytest
from pydantic import ValidationError

from app.domains.crypto.reference.identity import generate_identity, wrap_private_bundle
from app.domains.crypto.schemas.crypto_schemas import (
    ENCRYPTED_BUNDLE_MAX_LENGTH,
    RewrappedIdentity,
)


def _valid_kdf_params() -> dict:
    bundle = generate_identity(uuid.uuid4(), uuid.uuid4())
    _, kdf_params = wrap_private_bundle(bundle, "TestPassw0rd!")
    return kdf_params


def test_a_real_wrapped_bundle_is_well_within_the_bound():
    """Sanity check for the `ENCRYPTED_BUNDLE_MAX_LENGTH` assumption: a real sealed bundle, as
    produced by `wrap_private_bundle`, is a small fraction of the bound."""
    bundle = generate_identity(uuid.uuid4(), uuid.uuid4())
    wrapped, _ = wrap_private_bundle(bundle, "TestPassw0rd!")
    assert len(wrapped) < ENCRYPTED_BUNDLE_MAX_LENGTH // 10


def test_valid_kdf_params_round_trip():
    kdf_params = _valid_kdf_params()
    obj = RewrappedIdentity(
        device_id=uuid.uuid4(),
        encrypted_private_bundle="a" * 100,
        kdf_params=kdf_params,
    )
    assert obj.kdf_params == kdf_params


def test_oversized_bundle_is_rejected():
    kdf_params = _valid_kdf_params()
    with pytest.raises(ValidationError):
        RewrappedIdentity(
            device_id=uuid.uuid4(),
            encrypted_private_bundle="a" * (ENCRYPTED_BUNDLE_MAX_LENGTH + 1),
            kdf_params=kdf_params,
        )


def test_kdf_params_with_an_unexpected_key_is_rejected():
    """A key the client can never reproduce (or a smuggling attempt through an otherwise
    unbounded dict) must be refused rather than silently ignored."""
    kdf_params = _valid_kdf_params()
    kdf_params["extra_unexpected_field"] = "x" * 10_000

    with pytest.raises(ValidationError):
        RewrappedIdentity(
            device_id=uuid.uuid4(),
            encrypted_private_bundle="a" * 100,
            kdf_params=kdf_params,
        )


def test_kdf_params_below_the_argon2id_minimum_is_still_rejected():
    kdf_params = _valid_kdf_params()
    kdf_params["m"] = 1024

    with pytest.raises(ValidationError):
        RewrappedIdentity(
            device_id=uuid.uuid4(),
            encrypted_private_bundle="a" * 100,
            kdf_params=kdf_params,
        )
