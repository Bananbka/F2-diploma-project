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

## 3. Signed-prekey rotation — closed

`PUT /crypto/identity/prekey` used to return 410 unconditionally. See *Known broken areas* in
`CLAUDE.md` for the incident this closes — that note is itself stale now and should be removed or
updated the next time `CLAUDE.md` is touched.

**Short version of the original problem.** Grants are wrapped to
`signed_prekey_public ?? identity_public_key`, but the prekey's private half had nowhere to live:
the bundle was sealed under an Argon2id key derived from the password, and the password is not
retained after unlock. A device that published a prekey made every grant addressed to it
unopenable.

**What changed, server side.** The sealed private bundle now carries an optional `prekey_private`
alongside `signing_private`/`identity_private` (`docs/crypto-spec-v1.md` §2.2), generated at
registration by the reference implementation so it is available immediately after unlock with no
extra password prompt. `PUT /crypto/identity/prekey` (§2.1.2) now actually rotates: it verifies the
new prekey's signature against the device's on-record signing key, then writes the new public
prekey and the re-sealed bundle in one transaction. `identity_service.rotate_prekey` and the
`test_prekey_rotation.py` suite cover success, both signature-failure shapes, an unknown/foreign
device, and a bundle sealed before this existed rotating cleanly into the new format.

**What changed, client side.** `KeyStoreService` (`src/front/src/app/core/services/key-store.service.ts`)
now carries `prekeyPrivate` and `prevPrekeyPrivate` on the unlocked identity, and
`unwrapGrantForSelf` tries them in order — `prekeyPrivate`, then `prevPrekeyPrivate`, then
`identityPrivate` — before reporting a grant unopenable. `rotatePrekey()` generates a fresh X25519
pair, carries the outgoing `prekeyPrivate` forward as `prevPrekeyPrivate` (dropping whatever it held
before), re-seals the bundle under the KEK already held in memory, and submits it in one call —
matching `docs/crypto-spec-v1.md` §2.1.2/§2.2 exactly. `profile.component.ts` exposes it as
"Rotate prekey" under Settings → Your devices.

**What this still doesn't claim.** Forward secrecy across prekey rotations is a property of the
*wrapping*, not of storage — rotating the prekey only helps once new grants are actually wrapped to
the new key and old ones are allowed to age out. That is unchanged by this fix and remains future
work.

---

## 4. Test coverage is uneven — closed

`src/api/tests/crypto/` now also covers the chats domain, profile, plain message CRUD, and the two
previously-untested Celery task modules; the frontend's three highest-value components are now
specced; and the whole integration suite runs with rate limiting genuinely on.

- **The chats domain had no dedicated suite — fixed.** New `test_chats_api.py`: chat
  creation (private/group/channel), `chat_services.role_rank` RBAC directly (an admin cannot
  remove/outrank an owner, an owner can remove an admin, a plain member cannot remove anyone, two
  equal-rank admins cannot remove each other, all three RBAC endpoints reject `PRIVATE` chats),
  chat-list ordering/enrichment and the group-dedup regression guard, ownership transfer and chat
  deletion. Writing these tests surfaced and fixed a real bug: `get_chat_by_id` could return a
  stale `participants` list in the SAME request's response after an add/remove (not in the
  database, and not in any later request) whenever the `Chat` row was already in that request's
  SQLAlchemy identity map — `selectinload` doesn't refresh an already-populated collection on an
  identity-map hit. Fixed with `.execution_options(populate_existing=True)`.
- **Profile and message CRUD — fixed.** New `test_profile_api.py` (partial-update semantics,
  avatar-replace GC) and `test_message_crud_api.py` (plain CRUD, ownership gating, attachment
  wholesale-replace/clear, shared-attachment delete-reaping).
- **No frontend component tests beyond a handful — fixed for the three that matter most.**
  `chat-view.component.spec.ts`, `composer.component.spec.ts` and
  `message-bubble.component.spec.ts` now cover the `DecryptStatus` → rendering contract from
  `docs/ui-states.md` (every status renders through its own view, `canRenderMedia` gating verified
  against actual DOM output, not just signal state), the `no_key` grace-period timer, and —
  specifically flagged in `CLAUDE.md`'s "Lessons" section as having no structural enforcement — the
  `editing()` guard on every composer trigger, including the asymmetric case of a recording already
  in flight when editing starts on a different message.
- **Celery tasks — the two remaining untested ones now have coverage.** New `test_user_tasks.py`
  (`prune_security_audit_task`'s retention cutoff, `send_email`'s unconfigured-SMTP and
  unknown-type paths) and `test_file_tasks.py` (`cleanup_minio_orphans`/
  `cleanup_minio_avatar_orphans`, both buckets, referenced-vs-orphaned). `test_rotation_tasks.py`
  already covered the crypto rotation/pruning tasks and was left alone.

**The rate-limiting awkwardness — fixed with a test-only bypass, not a disabled limiter.**
`client_identifier(request)` in `app/core/rate_limit.py` mints a fresh random identifier instead of
the real address when the request carries a header matching the new
`settings.RATE_LIMIT_TEST_BYPASS_TOKEN` (default `None` — dead code unless deliberately set). This
only affects the IP-keyed scopes the registration-heavy test suite collides on
(`register`/`verify-email`/`login-ip`/`forgot-ip`/`reset-ip`); every account-scoped limit is
untouched. `RATE_LIMIT_ENABLED=true` is now the suite's actual running configuration — 329 tests
across `tests/crypto`+`tests/stickers`, all green with limits genuinely on. See `CLAUDE.md`'s
*Tests* section for the mechanism and its deployment caveat.

---

## 5. Smaller items

- **Per-user read receipts are now implemented.** `GET /chats/{id}/read-state` returns each
  participant's own `last_read_message_id`, so the client derives per-message read status (and a
  group's "read by N of M") itself instead of relying on the old shared `is_read` boolean, which is
  kept only for backward compat. This closes the item that used to be here — see
  `docs/ui-states.md`.
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
- **Reactions, pinning, mute and invite links are implemented.** `toggle_reaction`, `pin_message`/
  `unpin_message` (capped at `MAX_PINNED_MESSAGES_PER_CHAT = 5`), `set_chat_mute`
  (`chat_services.py`) and `ChatInviteLink` (atomic `use_count` consumption, optional `max_uses`/
  `expires_at`) all exist end to end, backend and frontend, with dedicated test suites. **No polls
  or scheduled messages.** No backend exists for either, so the UI does not offer them — a control
  that cannot work is worse than none.

---

## 7. Media-features follow-ups (stickers, object storage) — closed

Found during a live post-deploy smoke test of the `feat/media-and-ui-features` branch. All three
items below are now fixed.

**Sticker creation UX was unfriendly — fixed.** `sticker-pack-manager`'s "add sticker" flow used to
ask the user to type an emoji into a plain text field. Replaced with a hand-rolled
`shared/ui/emoji-picker/` popover (curated ~220-emoji grid across 6 categories, no new npm
dependency — follows this branch's existing hand-rolled style for waveform/resize/voice-recording)
wired into the same `uploadEmoji` signal the old `<input>` wrote to.

**Sent stickers rendered as the emoji/name instead of the image — root-caused and fixed.** It was
never the `message-bubble` template's `kind === 'sticker'` branch itself (that was always correct).
The real bug was one level down: `MinioClient.upload_file` built every object's public URL from
`settings.MINIO_URL`, the Docker-internal hostname (`http://minio:9000`) — fine for the server's own
S3 client, but that same URL was also handed straight to the browser as `<img src>` for avatars and
stickers (the only two public buckets), and a browser outside the Docker network can never resolve
that hostname. The image request failed and the browser fell back to rendering the `alt` text — the
sticker's emoji/name — which is exactly the symptom reported. Message attachments never hit this
because they're always fetched through the authenticated same-origin API proxy, never a raw stored
URL. Fixed by adding a separate `MINIO_PUBLIC_URL` setting (browser-reachable, used only for the
avatar/sticker buckets) and switching every URL-prefix validator/comparison for those two buckets to
it, while the private message bucket correctly stays on the internal `MINIO_URL`. See
`app/infrastructure/minio.py`'s `upload_file(..., public: bool)` and the `MINIO_PUBLIC_URL` entries
in *Environment files* in `CLAUDE.md`. This also silently fixed the same bug for avatars, which had
never been reported but had the identical defect.

**MinIO was in a bad state and due for replacement — migrated to RustFS.** `docker-compose.yml`'s
`minio` service is now `rustfs` (image `rustfs/rustfs:latest`), same S3-compatible API surface, same
`MINIO_USER`/`MINIO_PASSWORD` credentials feeding its `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`. The
`Settings`/`minio_manager` Python identifiers were deliberately left unchanged — this stayed a pure
endpoint/credential swap, not an application-code rewrite, as originally scoped here. Old `minio_data`
volume was dropped (its contents were already lost/broken); RustFS starts on a fresh `rustfs_data`
volume.

---

## 8. Loading a chat's recent history fires far too many requests — closed

Root-caused: each visible image/video/audio attachment was triggering its own independent
`GET /files/attachments/{chat_id}/{object_key}` round trip (one `get_chat_or_403` + Mongo `find_one`
each) the moment it scrolled into view or rendered. Nothing *else* was going per-message — it was
genuinely N attachment fetches for N visible attachments, inherent to per-attachment E2E decryption
until batched.

**Fixed with a batch download endpoint.** `POST /files/attachments/batch` (`chat_id`,
`object_keys: list[str]`, capped at 50 per call) authorizes the chat once, runs one Mongo `$in` query
to determine which requested keys are actually referenced in that chat, and returns a
base64-carrying JSON result per key (`ok`/`not_found`/`gone`) instead of multipart — a deliberate
simplicity-over-byte-efficiency tradeoff, since the payload is already-opaque client-encrypted
ciphertext so base64's ~33% overhead isn't a real loss. Client side, a new
`core/services/attachment-batch.service.ts` coalesces every `ensureDecrypted` call that fires within
the same microtask (e.g. a whole screenful of tiles becoming visible at once) into as few batch calls
as the 50-key cap allows, scoped per chat id, and `message-bubble.component.ts` now calls it instead
of issuing its own `http.get` per attachment. Rate-limited server side
(`attachments_batch`, 300/hour); a 429 or any other batch failure surfaces as the existing
per-attachment `error` state rather than crashing — it does not currently auto-retry later (no
backoff, unlike the `no_key` grace-period handling elsewhere in `message-bubble`), which is worth a
small follow-up if it turns out to matter in practice.

---

## 9. Noted for future work (not started)

Raised by the user on 2026-10-14; recorded here rather than acted on immediately.

- **Production-readiness architecture review.** The current setup (single `api`/`frontend`
  instance each, `uvicorn --reload`, no TLS, no CI, no observability stack) is a dev/diploma
  configuration, not a deployable one. Needs a real pass at what an actual open-source project in
  this space would run: a proper ASGI process manager instead of bare `--reload` uvicorn, TLS
  termination (see §1), structured metrics/tracing, CI (lint/test/build on push), dependency/image
  scanning, and a documented deployment target — not just incremental fixes to the dev compose
  file like the gateway split or RustFS migration already done in §7 and this session.
- **No chat-view side panel for emoji/stickers.** Telegram-style: a panel on the right side of the
  conversation (or a slide-over) exposing the emoji picker and sticker tray together, rather than
  today's composer-trigger-opens-a-popover pattern (`shared/ui/emoji-picker/`,
  `features/chat/stickers/sticker-picker/`). Not scoped or designed yet.
- **Chat list shows a bare username/title, not a message preview, in some path(s) the user has
  seen.** `chat-sidebar.component.ts`/`.html` already has a `preview(chat)` mechanism driven by
  `chat.last_message` (readable/sealed states, used for the list's timestamp too), so this may be a
  narrower gap than "entirely missing" — worth actually tracing which case(s) still fall back to a
  bare username before scoping a fix, rather than assuming the whole feature needs to be built from
  scratch.

---

## 10. Знайдене під час огляду безпекового загартування (не виправлено)

Виявлено під час огляду гілки `feat/security-hardening-and-idempotency`. Нічого з цього не
з'явилося через ці зміни, окрім пункту про повтор після видалення.

- **Відкритий WebSocket переживає відкликання сесії.** Токен, denylist і `force_logout`
  перевіряються лише під час рукостискання. Після виходу, зміни чи скидання пароля сокет
  далі отримує події `user:{id}`, доки не закриється сам. Вміст лишається зашифрованим, але
  метадані та події членства доступні. Виправлення: публікувати `session_revoked` у канал
  користувача й закривати сокет, або повторно перевіряти сесію за таймером.
- **Немає перевірки Origin для HTTP-методів, що змінюють стан.** `SameSite=Lax` не захищає
  від запитів зі сторонніх origin того самого сайту (інший порт у розробці, піддомен у
  виробничому середовищі). Виправлення: проміжний обробник, що відхиляє `POST`/`PUT`/
  `PATCH`/`DELETE` з Origin поза списком.
- **Повтор після видалення створює повідомлення знову.** Видалення фізичне, тому
  `client_message_id` зникає разом із документом. Приймається як обмеження; виправлення
  потребує тимчасового запису «бачених» ідентифікаторів.
- **Відбиток ідемпотентності не охоплює шифротекст.** Ручний повтор перешифровує
  повідомлення, тож порівняти вміст неможливо; відрізняються лише reply, вкладення, формат
  і пересилання.
- **Подія `typing` у WebSocket не має ліміту частоти** і пересилає `payload` без очищення
  ключів.
- **Вхід розкриває існування імені користувача за часом відповіді:** `bcrypt` не
  виконується, якщо користувача немає.
- **Перехідне читання старого формату denylist** коштує зайвого `GET` на запит. Прибрати
  через 7 днів після розгортання (позначено `TODO` у `core/security.py`).
- **OTP, видані до розгортання, перестають діяти:** старі коди зберігалися відкритим текстом.
  Користувач просто запитує новий код.
- **Налаштування середовища.** `EXPOSE_API_DOCS=true` потрібно додати в `src/api/.env`, інакше
  `/docs` повертає 404. `ALLOWED_WS_ORIGINS` задається JSON-списком.
