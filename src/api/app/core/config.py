from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Postgres
    DATABASE_URL: str

    # MongoDB
    MONGO_URL: str
    MONGO_DB_NAME: str = "messenger_db"

    # Redis
    REDIS_URL: str

    # MinIO
    MINIO_URL: str
    MINIO_USER: str
    MINIO_PASSWORD: str
    MINIO_MESSAGE_BUCKET: str = "messages-attachments"
    MINIO_AVATAR_BUCKET: str = "user-avatars"

    # JWT
    SECRET_KEY: str
    ALGORITHM: str = "HS256"

    # Set to False only for local HTTP development; auth cookies leak over plaintext without it.
    COOKIE_SECURE: bool = True

    # EMAIL
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str | None = None
    SMTP_PASSWORD: str | None = None
    EMAILS_FROM_NAME: str = "Mess&Gags Security"

    TIMEZONE: str = "Europe/Kyiv"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
