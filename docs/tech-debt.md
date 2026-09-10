# Known debt

What is deliberately unfinished, and why. Kept separate from `CLAUDE.md`'s *Known broken areas*,
which describes things that are actively wrong; everything here is a decision, not a defect.

The point of writing these down is that a thesis is judged partly on knowing what you did not
build. An honest list is stronger than an implied claim of completeness.

---

## 1. No TLS

nginx listens on `:80` only. Every security header is in place and the HSTS line is written and
commented out in `src/front/security-headers.conf`.

**Why not done.** It needs a domain and certificates, which is a deployment decision rather than a
code change. Enabling HSTS before certificates exist would lock users out of a working
deployment, and sending it over plain HTTP is ignored by browsers anyway.

**What it costs today.** Cookies carry `Secure` only when `COOKIE_SECURE` is on, which local
development turns off. Over plain HTTP the transport is readable — the *message* contents are not,
because they are sealed client-side, but metadata, cookies and the wrapped key bundle are.

**To close it.** Terminate TLS at nginx, set `COOKIE_SECURE=true`, uncomment the HSTS line.
An afternoon once a certificate exists.

---

## 2. No offline delivery queue

The proposal names a "координатор черг асинхронної доставки для тимчасово відключених пристроїв".
There isn't one. Redis pub/sub is fire-and-forget: anything published while a user is disconnected
is simply lost.

**What exists instead.** The client reconciles on reconnect by re-fetching over HTTP, and it
deduplicates by message id and inserts by ObjectId, so what the user *sees* is complete and
correctly ordered. That is reconciliation at the edge, not a guarantee from the transport.

**Why the distinction matters.** "гарантія дедуплікації та збереження порядку доставки" is only
half true, and should be described that way rather than claimed. There is no ack, no server-side
dedup, and no redelivery.

**To close it.** Per-user inbox streams (Redis Streams fit: consumer groups give acks and
redelivery for free) with a client cursor, replacing the fire-and-forget publish. A substantial
feature, not a fix.

---

## 3. Signed-prekey rotation is disabled

`PUT /crypto/identity/prekey` returns 410. See *Known broken areas* in `CLAUDE.md` for the full
account.

**Short version.** Grants are wrapped to `signed_prekey_public ?? identity_public_key`, but the
prekey's private half has nowhere to live: the bundle is sealed under an Argon2id key derived from
the password, and the password is not retained after unlock. A device that publishes a prekey
makes every grant addressed to it unopenable.

**What that costs.** Forward secrecy across prekey rotations is not claimed. The identity key is
the grant recipient, so compromising it exposes every grant wrapped to it, not just recent ones.

**To close it.** `prekey_private` has to be generated at registration and live inside the sealed
bundle from the start, with rotation deferred until there is somewhere to put the new half. The
signature machinery around it (`DS_PREKEY_BIND`, `verify_signed_prekey`, both references, the
interop vector, the spec section) is already correct and should be kept.

---

## 4. Test coverage is uneven

`src/api/tests/crypto/` covers the crypto surface, authorization, the rate limiter, and — as of
the last pass — folders, contacts and files. What that leaves:

- **The chats domain has no dedicated suite.** Chat creation, participant RBAC and the chat list
  are exercised only incidentally, as setup for other tests. The rank-comparison rules in
  `chat_services.role_rank` in particular deserve direct tests: they are the reason an admin
  cannot remove an owner.
- **Profile and the message CRUD paths** are covered only where a crypto test happens to touch
  them.
- **No frontend component tests beyond a handful.** 57 specs, almost all on the logic layer. The
  chat view, composer and message bubble are untested, which is where the `DecryptStatus`
  rendering rules in `docs/ui-states.md` actually live.
- **Nothing exercises the Celery tasks end to end** except `test_rotation_tasks.py`.

**The awkward part.** The integration suite has to run with `RATE_LIMIT_ENABLED=false`, because it
registers dozens of accounts from one address — exactly the pattern the registration limit exists
to stop. The limiter has its own unit tests that turn it back on, so it is not left uncovered, but
the suite cannot prove the limits are wired into the endpoints. A per-test limiter reset, or a
test-only allowlisted address, would let the suite run with limits on.

---

## 5. Smaller items

- **`is_pinned` exists on `MessageDocument` and no endpoint sets it.** Either implement pinning or
  drop the field; a field that is always false invites UI built on it.
- **Per-user read receipts are unimplementable as designed.** `is_read` is a single shared boolean,
  so one member reading marks a group message read for everyone. This is why only a sent tick is
  shown. Fixing it means a per-participant read table.
- **The `presence:{user_id}` refcount can drift** if a process is killed between `incr` and the
  `finally` that decrements. It self-heals after the 24h TTL. A heartbeat, or deriving presence
  from live pubsub subscriptions rather than a counter, would remove the failure mode.
- **`ReceiverChain.skipped` is memory-only.** A reload loses the retained keys, so a genuinely
  late message that arrives after a refresh reports `failed` rather than opening. Persisting chain
  state in IndexedDB under a key wrapped by the KEK is the documented intent.
- **Two `Cache-Control` headers on static assets** — nginx emits one from `expires 1y` and one from
  `add_header`. Harmless (browsers take the first) but untidy.
- **No account deletion.** A user can be disabled via `is_active`, but nothing exposes it and
  there is no way to erase an account.

---

## 6. Not debt, but worth knowing

These look like gaps and are deliberate:

- **Channels are signed, not encrypted.** Confidentiality is unachievable for open-enrollment
  broadcast, and sender-key distribution does not scale to channel membership. See
  `docs/crypto-spec-v1.md` §6.
- **`forwarded_from` is unverifiable.** A forward under E2E is a re-send sealed by the forwarder,
  so provenance is the forwarder's claim. The UI must never render it as verified.
- **No reactions, pinning, mute, invite links, polls or scheduled messages.** No backend exists for
  any of them, so the UI does not offer them — a control that cannot work is worse than none.
