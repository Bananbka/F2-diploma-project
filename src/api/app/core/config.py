from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Postgres
    DATABASE_URL: str

    # MongoDB
    MONGO_URL: str
    MONGO_DB_NAME: str = "messenger_db"

    # Redis
    REDIS_URL: str
    # Separate Redis for WebSocket events (streams, pub/sub, gap markers): non-persistent and
    # evicting (`allkeys-lru`), unlike REDIS_URL's noeviction instance that holds the token
    # denylist. Deliberately has no default and no fallback to REDIS_URL, so events can never
    # silently end up competing with security state.
    EVENTS_REDIS_URL: str

    # Object store (RustFS, S3-compatible; `MinioClient` in app/infrastructure/minio.py is an S3
    # client, kept under its existing name since the backing service changed, not the API shape).
    MINIO_URL: str
    # Browser-reachable base for the public buckets (avatars, stickers) only. MINIO_URL is the
    # compose-network hostname the server uses to reach the store, which a browser outside the
    # Docker network can never resolve — using it as an <img src> base silently fails to load and
    # falls back to rendering the alt text, which is what this setting exists to avoid.
    MINIO_PUBLIC_URL: str
    MINIO_USER: str
    MINIO_PASSWORD: str
    MINIO_MESSAGE_BUCKET: str = "messages-attachments"
    MINIO_AVATAR_BUCKET: str = "user-avatars"
    MINIO_STICKER_BUCKET: str = "sticker-assets"

    # JWT
    SECRET_KEY: str
    ALGORITHM: str = "HS256"

    # Set to False only for local HTTP development; auth cookies leak over plaintext without it.
    COOKIE_SECURE: bool = True

    # Rate limiting. On by default, because every unauthenticated endpoint depends on it — the
    # six-digit OTP in particular is only safe while guesses are scarce.
    #
    # The integration suite in tests/crypto registers dozens of accounts from one address, which
    # is exactly the pattern the registration limit exists to stop, so it has to be turned off for
    # those runs. Never turn it off anywhere a real user can reach.
    RATE_LIMIT_ENABLED: bool = True

    # Test-only escape hatch. When set, a request carrying the header named by
    # `rate_limit.TEST_BYPASS_HEADER` with this exact value is given a fresh, unique identifier for
    # every IP-keyed rate limit check instead of its real client address — see
    # `rate_limit.client_identifier`. This is what lets the integration suite run with
    # RATE_LIMIT_ENABLED=true even though every request in it originates from the same container:
    # the suite sets this to a secret only it knows, rather than the limiter trusting an address or
    # header a real client could ever send. Must never be set outside a test environment — it is
    # `None` by default, and leaving it unset is what keeps this dead code in production.
    RATE_LIMIT_TEST_BYPASS_TOKEN: str | None = None

    # Browser origins the API trusts. Browsers always send Origin on a WS handshake, so a missing
    # or foreign one is refused there: cookie auth alone would let any site the user visits open an
    # authenticated socket (cross-site WebSocket hijacking). The same list gates state-changing
    # HTTP methods, but only when an Origin header is present (non-browser clients send none).
    # Set from the environment as JSON, e.g. ALLOWED_ORIGINS=["https://chat.example.com"].
    # The earlier name ALLOWED_WS_ORIGINS is still read as a fallback.
    ALLOWED_ORIGINS: list[str] = Field(
        default=["http://localhost:4200", "http://127.0.0.1:4200"],
        validation_alias=AliasChoices("ALLOWED_ORIGINS", "ALLOWED_WS_ORIGINS"),
    )

    # How often an open WebSocket re-validates its session (denylist, force_logout, is_active,
    # token expiry), in seconds. Revocation events close it immediately; this is the backstop.
    WS_SESSION_RECHECK_SECONDS: int = 60

    # Per-user event stream (`stream:user:{id}`) in the events Redis, the replay source for a
    # reconnecting socket. MAXLEN is approximate (`~`). The TTL is refreshed on every write.
    # The events Redis evicts (allkeys-lru) and has no persistence, so a stream can also vanish
    # early (memory pressure, restart); the client then gets `resync_required`.
    EVENT_STREAM_MAXLEN: int = 200
    EVENT_STREAM_TTL_SECONDS: int = 7 * 24 * 3600
    # An event larger than this is published live only and leaves a gap marker (a reconnecting
    # client is then told to resync) instead of occupying stream memory.
    EVENT_STREAM_MAX_ENTRY_BYTES: int = 32 * 1024
    # Most events one reconnect will replay. A longer gap is answered with `resync_required`
    # rather than a partial replay: the client reloads over HTTP, which is cheaper than a flood.
    WS_REPLAY_MAX_EVENTS: int = 500
    # Connects that carry a cursor (each costs a replay read), per user per window.
    WS_REPLAY_CONNECT_LIMIT: int = 30
    WS_REPLAY_CONNECT_WINDOW: int = 60

    # Swagger/ReDoc/openapi.json are off unless explicitly enabled (dev only).
    EXPOSE_API_DOCS: bool = False

    # Log every SQL statement. It was hardcoded on, which made the logs enormous and put bound
    # parameters (user data) in them; opt in with SQL_ECHO=true when debugging queries.
    SQL_ECHO: bool = False

    # EMAIL
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str | None = None
    SMTP_PASSWORD: str | None = None
    EMAILS_FROM_NAME: str = "Mess&Gags Security"

    TIMEZONE: str = "Europe/Kyiv"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
