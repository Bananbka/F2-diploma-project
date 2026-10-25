"""add users.deleted_at for account-deletion tombstones (TB-28)

Revision ID: e5f3a7c9d124
Revises: d4e2f6b8c013
Create Date: 2026-10-25

A deleted account stays as a `users` row with its personal data replaced and `deleted_at` set. The
row cannot be removed: the `ON DELETE CASCADE` foreign keys would take the identity keys, sender key
distributions and grants with it, and other members could then neither decrypt nor verify the
history that account took part in.

Accounts tombstoned before this column existed are recognised by the placeholder email the deletion
code wrote (`...@deleted.invalid`) together with `is_active = false`, and are backfilled.

No enum types are created, so `downgrade()` has nothing to drop in `pg_type`.

DATA LOSS ON DOWNGRADE: dropping `deleted_at` forgets which accounts are tombstones. They remain
inactive rows with placeholder values, but the API can no longer present them as "Deleted user" or
treat their private chats as read-only.
"""
from alembic import op
import sqlalchemy as sa

revision = 'e5f3a7c9d124'
down_revision = 'd4e2f6b8c013'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))
    op.execute(
        """
        UPDATE users
        SET deleted_at = COALESCE(updated_at, now())
        WHERE is_active = false AND email LIKE '%@deleted.invalid' AND deleted_at IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column('users', 'deleted_at')
