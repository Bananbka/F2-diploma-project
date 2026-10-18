FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .

RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev \
    && pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove gcc \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# --no-access-log: uvicorn's default access logger writes the full request path — including the
# invite-link token in `/invite-links/{token}` — verbatim to stdout, which `docker compose logs`
# captures. `app.main`'s own `log_requests` middleware already logs every request/response with
# loguru and redacts that token (see `_loggable_path`), so uvicorn's separate, unredacted access
# log is redundant as well as a leak and is disabled here rather than patched.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]