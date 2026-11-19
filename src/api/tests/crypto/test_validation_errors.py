"""422 responses and their log line must never echo the request.

Pydantic v2 puts the offending value in each error's `input` — and for a `missing` field that is the
whole enclosing body. Returned and logged verbatim, a login without a username disclosed the password
and a malformed reset request the OTP and the new password. The handler now keeps `loc`, `msg` and
`type` only.

The first group is pure unit tests (no server). The HTTP tests talk to the running API, like the
rest of the `*_api.py` suites.
"""

import json
import uuid

import httpx
import pytest
from fastapi.exceptions import RequestValidationError
from loguru import logger
from pydantic import BaseModel, Field, ValidationError

from app.core.exceptions import sanitize_validation_errors, validation_exception_handler

from tests.crypto.test_identity_api import BASE, rate_limit_bypass_headers

SECRET = "hunter2-" + uuid.uuid4().hex
OTP = "918273"


class _Login(BaseModel):
    username: str
    password: str


class _Reset(BaseModel):
    username: str
    otp: str = Field(..., min_length=6, max_length=6)
    new_password: str = Field(..., min_length=8)


def _errors_for(model: type[BaseModel], body: dict) -> list[dict]:
    """Errors as FastAPI hands them to the handler: `loc` prefixed with `body`."""
    with pytest.raises(ValidationError) as info:
        model.model_validate(body)
    return [{**e, "loc": ("body", *e["loc"])} for e in info.value.errors()]


async def _run_handler(errors: list[dict]) -> tuple[dict, list[str]]:
    lines: list[str] = []
    sink_id = logger.add(lines.append, level="WARNING", format="{message}")
    try:
        response = await validation_exception_handler(None, RequestValidationError(errors))
    finally:
        logger.remove(sink_id)
    assert response.status_code == 422
    return json.loads(response.body), lines


def test_raw_pydantic_errors_do_carry_the_secret():
    """Guards the test itself: if Pydantic stopped echoing `input`, the tests below would pass
    vacuously."""
    errors = _errors_for(_Login, {"password": SECRET})
    assert SECRET in repr(errors)


def test_sanitize_keeps_only_loc_msg_and_type():
    errors = _errors_for(_Reset, {"otp": "1", "new_password": SECRET})
    cleaned = sanitize_validation_errors(errors)

    assert cleaned, "every error must still be reported"
    for error in cleaned:
        assert set(error) <= {"loc", "msg", "type"}
        assert "input" not in error and "ctx" not in error and "url" not in error
    assert SECRET not in repr(cleaned)
    assert {e["type"] for e in cleaned} == {"missing", "string_too_short"}


async def test_handler_response_and_log_omit_the_password():
    body, lines = await _run_handler(_errors_for(_Login, {"password": SECRET}))

    assert body["error_code"] == "VALIDATION_ERROR"
    assert body["details"] == [{"loc": ["body", "username"], "msg": "Field required", "type": "missing"}]
    assert SECRET not in json.dumps(body)

    assert lines, "the validation failure must still be logged"
    assert all(SECRET not in line for line in lines)


async def test_handler_response_and_log_omit_the_otp_and_new_password():
    body, lines = await _run_handler(_errors_for(_Reset, {"otp": OTP, "new_password": SECRET}))

    dumped = json.dumps(body)
    assert SECRET not in dumped and OTP not in dumped
    assert all(SECRET not in line and OTP not in line for line in lines)


@pytest.fixture
async def anon():
    client = httpx.AsyncClient(base_url=BASE, timeout=30.0, headers=rate_limit_bypass_headers())
    try:
        yield client
    finally:
        await client.aclose()


async def test_login_without_username_does_not_echo_the_password(anon):
    r = await anon.post("/auth/login", json={"password": SECRET})

    assert r.status_code == 422, r.text
    assert SECRET not in r.text
    assert r.json()["error_code"] == "VALIDATION_ERROR"
    for error in r.json()["details"]:
        assert "input" not in error and "ctx" not in error


async def test_malformed_reset_does_not_echo_the_otp_or_new_password(anon):
    r = await anon.post("/auth/reset-password", json={"otp": OTP, "new_password": SECRET})

    assert r.status_code == 422, r.text
    assert SECRET not in r.text and OTP not in r.text
