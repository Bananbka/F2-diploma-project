"""add users.chat_appearance

Revision ID: c9a1d3e5f702
Revises: b8d2f4a6c901
Create Date: 2026-11-08

Nullable JSONB per-user chat appearance. DATA LOSS ON DOWNGRADE: saved appearances are lost.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'c9a1d3e5f702'
down_revision = 'b8d2f4a6c901'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('chat_appearance', postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'chat_appearance')
