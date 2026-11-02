"""The socket must not pin a pooled Postgres connection, and bcrypt must stay off the event loop."""

import inspect
import threading

from app.core import security
from app.core.config import settings
from app.domains.messages.routes import ws_router
from app.domains.users import dependencies
from app.infrastructure.postgres import engine


def _params(fn) -> set[str]:
    return set(inspect.signature(fn).parameters)


def test_ws_endpoint_has_no_request_scoped_db():
    assert "db" not in _params(ws_router.websocket_endpoint)
    assert "db" not in _params(dependencies.get_ws_current_user)


def test_ws_helpers_open_their_own_sessions():
    assert "db" not in _params(ws_router._broadcast_presence)
    assert "db" not in _params(ws_router._may_act_on)


def test_pool_is_configured_explicitly():
    pool = engine.pool
    assert pool.size() == settings.DB_POOL_SIZE
    assert pool._max_overflow == settings.DB_MAX_OVERFLOW
    assert pool._pre_ping is True


async def test_async_bcrypt_round_trips_off_the_loop(monkeypatch):
    main_thread = threading.get_ident()
    seen: list[int] = []
    real = security.verify_password

    def spy(plain, hashed):
        seen.append(threading.get_ident())
        return real(plain, hashed)

    monkeypatch.setattr(security, "verify_password", spy)

    hashed = await security.get_password_hash_async("correct horse")
    assert await security.verify_password_async("correct horse", hashed) is True
    assert await security.verify_password_async("wrong", hashed) is False
    assert seen and all(t != main_thread for t in seen)
    # The sync functions still interoperate with the async ones.
    assert security.verify_password("correct horse", hashed)
