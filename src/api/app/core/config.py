from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Postgres
    DATABASE_URL: str

    # MongoDB
    MONGO_URL: str
    MONGO_DB_NAME: str = "messenger_db"

    # Redis
    REDIS_URL: str

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

    # Origins allowed to open the WebSocket. Browsers always send Origin on a WS handshake, so a
    # missing or foreign one is refused: cookie auth alone would let any site the user visits
    # open an authenticated socket (cross-site WebSocket hijacking).
    # Set from the environment as JSON, e.g. ALLOWED_WS_ORIGINS=["https://chat.example.com"].
    ALLOWED_WS_ORIGINS: list[str] = ["http://localhost:4200", "http://127.0.0.1:4200"]

    # Swagger/ReDoc/openapi.json are off unless explicitly enabled (dev only).
    EXPOSE_API_DOCS: bool = False

    # EMAIL
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str | None = None
    SMTP_PASSWORD: str | None = None
    EMAILS_FROM_NAME: str = "Mess&Gags Security"

    TIMEZONE: str = "Europe/Kyiv"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
