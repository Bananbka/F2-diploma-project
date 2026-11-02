"""add optional icon to chat_folders

Revision ID: b8d2f4a6c901
Revises: a7c3e9f1b2d4
Create Date: 2026-11-03

Nullable lucide kebab-case icon name. No backfill needed. DATA LOSS ON DOWNGRADE: icons are lost.
"""
from alembic import op
import sqlalchemy as sa

revision = 'b8d2f4a6c901'
down_revision = 'a7c3e9f1b2d4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('chat_folders', sa.Column('icon', sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column('chat_folders', 'icon')
