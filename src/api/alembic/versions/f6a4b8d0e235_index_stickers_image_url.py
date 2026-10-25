"""index stickers.image_url for lookup by sticker url

Revision ID: f6a4b8d0e235
Revises: e5f3a7c9d124
Create Date: 2026-10-25

`GET /stickers/by-url` resolves a message attachment's public url to its pack. No enum types are
created, so `downgrade()` has no `pg_type` entries to drop.
"""
from alembic import op

revision = 'f6a4b8d0e235'
down_revision = 'e5f3a7c9d124'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(op.f('ix_stickers_image_url'), 'stickers', ['image_url'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_stickers_image_url'), table_name='stickers')
