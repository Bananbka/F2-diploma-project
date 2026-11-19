"""Seal real envelopes for tests that only need *a* message to exist.

The server no longer stores plaintext: a private or group message must be a `SENDER_KEYS_V1`
envelope in a chat whose encryption has been enabled. Tests about pins, reactions, read state,
attachments, idempotency and so on still need messages, and used to post `encrypted_content`. They
now go through this module, which does what an honest client does:

  * publishes one device identity per client (lazily, on first use);
  * enables encryption on the chat if nobody has yet (the client does this on first open);
  * publishes a sender chain for the chat's current epoch, wrapped to every roster device;
  * seals each message from the next chain index.

State is kept per client object, so the same client sealing twice in one chat reuses its chain and
a rotation (new epoch) transparently publishes a fresh one.
"""

import uuid
import weakref
from dataclasses import dataclass, field

import httpx

from app.domains.crypto.reference.envelope import seal_message
from app.domains.crypto.reference.identity import IdentityBundle
from app.domains.crypto.reference.ratchet import SenderChain

from tests.crypto.test_epoch_api import _publish_identity
from tests.crypto.test_rotation_api import _publish_chain


@dataclass
class _ChainState:
    chain: SenderChain
    skid: uuid.UUID
    chain_identity: IdentityBundle


@dataclass
class _ClientState:
    user_id: uuid.UUID
    device_id: uuid.UUID
    bundle: IdentityBundle
    chains: dict[tuple[uuid.UUID, int], _ChainState] = field(default_factory=dict)


_STATE: "weakref.WeakKeyDictionary[httpx.AsyncClient, _ClientState]" = weakref.WeakKeyDictionary()


async def _client_state(client: httpx.AsyncClient) -> _ClientState:
    state = _STATE.get(client)
    if state is None:
        r = await client.get("/profile/me")
        assert r.status_code == 200, r.text
        user_id = uuid.UUID(r.json()["data"]["id"])
        device_id, bundle = await _publish_identity(client, user_id)
        state = _ClientState(user_id=user_id, device_id=device_id, bundle=bundle)
        _STATE[client] = state
    return state


async def ensure_identity(client: httpx.AsyncClient) -> None:
    """Publish this client's device identity now, so it is already in later rosters."""
    await _client_state(client)


async def enable(client: httpx.AsyncClient, chat_id) -> int:
    """Enable encryption on a chat (idempotent). Returns the current epoch.

    In a group only the owner may enable, so a test whose first sender is a plain member must call
    this with the owner's client first.
    """
    r = await client.get(f"/crypto/chats/{chat_id}/keys")
    if r.status_code == 200:
        return r.json()["data"]["current_epoch"]
    assert r.json().get("error_code") == "CRYPTO_NOT_ENABLED", r.text

    r = await client.post(f"/crypto/chats/{chat_id}/enable")
    if r.status_code == 409 and r.json().get("error_code") == "ALREADY_ENABLED":
        r = await client.get(f"/crypto/chats/{chat_id}/keys")
        assert r.status_code == 200, r.text
        return r.json()["data"]["current_epoch"]
    assert r.status_code == 200, r.text
    return r.json()["data"]["epoch"]


async def seal_for(client: httpx.AsyncClient, chat_id, body: str | bytes = b"x") -> dict:
    """A valid envelope from this client for the chat's current epoch."""
    chat_id = uuid.UUID(str(chat_id))
    state = await _client_state(client)
    epoch = await enable(client, chat_id)

    chain_state = state.chains.get((chat_id, epoch))
    if chain_state is None:
        chain_key, skid, chain_identity = await _publish_chain(
            client, chat_id, epoch, state.user_id, state.device_id, state.bundle
        )
        chain_state = _ChainState(SenderChain(chain_key), skid, chain_identity)
        state.chains[(chat_id, epoch)] = chain_state

    if isinstance(body, str):
        body = body.encode("utf-8")
    mk, nonce, idx = chain_state.chain.next_message_key()
    return seal_message(
        message_key=mk, nonce=nonce, signing_private=chain_state.chain_identity.signing_private,
        chat_id=chat_id, epoch=epoch, sender_id=state.user_id,
        sender_key_id=chain_state.skid, chain_index=idx, plaintext=body,
    )


async def send_sealed(
    client: httpx.AsyncClient, chat_id, body: str | bytes = b"x", **extra
) -> httpx.Response:
    """POST /messages/ with a freshly sealed envelope plus any extra request fields."""
    envelope = await seal_for(client, chat_id, body)
    return await client.post(
        "/messages/", json={"chat_id": str(chat_id), "envelope": envelope, **extra}
    )


async def edit_sealed(
    client: httpx.AsyncClient, message_id: str, chat_id, body: str | bytes = b"x", **extra
) -> httpx.Response:
    """PUT /messages/{id} with an envelope sealed from a fresh chain index."""
    envelope = await seal_for(client, chat_id, body)
    return await client.put(f"/messages/{message_id}", json={"envelope": envelope, **extra})
