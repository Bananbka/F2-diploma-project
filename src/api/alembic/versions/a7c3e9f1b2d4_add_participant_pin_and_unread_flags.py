"""add per-user chat menu state to chat_participants (pinned_at, marked_unread)

Revision ID: a7c3e9f1b2d4
Revises: f6a4b8d0e235
Create Date: 2026-11-01

Both columns live on the participant row, never on `chats`: pinning a chat or marking it unread is
one member's private arrangement of their own list and must not be visible to, or change anything
for, anyone else. Clearing history needs no column of its own - it reuses
`history_start_message_id`, which already floors every history read.

`marked_unread` is NOT NULL with a server default of false, so existing rows backfill without a
data step. No enum types are created, so `downgrade()` has nothing to drop in `pg_type`.

DATA LOSS ON DOWNGRADE: users lose their pinned chats and manual unread flags.
"""
from alembic import op
import sqlalchemy as sa

revision = 'a7c3e9f1b2d4'
down_revision = 'f6a4b8d0e235'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'chat_participants',
        sa.Column('pinned_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'chat_participants',
        sa.Column('marked_unread', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('chat_participants', 'marked_unread')
    op.drop_column('chat_participants', 'pinned_at')
