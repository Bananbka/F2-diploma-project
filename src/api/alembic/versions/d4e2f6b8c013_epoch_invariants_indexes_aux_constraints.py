"""epoch invariants, grant/chat indexes, auxiliary table constraints (TB-22, TB-23, TB-25)

Revision ID: d4e2f6b8c013
Revises: c3d1e5a7b902
Create Date: 2026-10-25

TB-22  `uq_open_epoch_per_chat`: at most one epoch per chat with `closed_at IS NULL`. The advisory
       lock in `allocate_epoch` serialises well-behaved callers; this makes a second open epoch
       impossible for everyone else. `UNIQUE (id, chat_id)` on `chat_key_epochs` lets
       `sender_key_distributions (epoch_id, chat_id)` reference it as a composite FK, so a
       distribution can no longer name an epoch that belongs to a different chat.
TB-23  `ix_grant_recipient_device`, `ix_grant_recipient_identity_key`, `ix_chats_updated_at DESC`.
TB-25  `chat_invite_links` use_count <= max_uses, `contacts` owner <> contact, and
       `stickers UNIQUE (pack_id, position)`.

Existing rows are checked first and the migration aborts, before any DDL, with the offending ids.
The exception is stickers: duplicate positions only affect display order, so they are renumbered
per pack (ordered by the old position, then id) rather than blocking the upgrade.

No enum types are created, so `downgrade()` has nothing to drop in `pg_type`.
"""
from alembic import op
import sqlalchemy as sa

revision = 'd4e2f6b8c013'
down_revision = 'c3d1e5a7b902'
branch_labels = None
depends_on = None

SAMPLE = 20


def _violations() -> list[str]:
    bind = op.get_bind()
    problems: list[str] = []

    def report(label: str, count_sql: str, ids_sql: str) -> None:
        count = bind.execute(sa.text(count_sql)).scalar()
        if not count:
            return
        ids = [str(r[0]) for r in bind.execute(sa.text(ids_sql + f" LIMIT {SAMPLE}")).all()]
        more = f" (+{count - len(ids)} more)" if count > len(ids) else ""
        problems.append(f"  {label}: {count} offender(s); {', '.join(ids)}{more}")

    report(
        "chats with more than one open epoch (chat_key_epochs.chat_id)",
        "SELECT count(*) FROM (SELECT chat_id FROM chat_key_epochs WHERE closed_at IS NULL "
        "GROUP BY chat_id HAVING count(*) > 1) t",
        "SELECT chat_id FROM chat_key_epochs WHERE closed_at IS NULL "
        "GROUP BY chat_id HAVING count(*) > 1 ORDER BY chat_id",
    )
    report(
        "sender_key_distributions whose chat_id differs from their epoch's chat_id",
        "SELECT count(*) FROM sender_key_distributions d JOIN chat_key_epochs e ON e.id = d.epoch_id "
        "WHERE e.chat_id <> d.chat_id",
        "SELECT d.id FROM sender_key_distributions d JOIN chat_key_epochs e ON e.id = d.epoch_id "
        "WHERE e.chat_id <> d.chat_id ORDER BY d.id",
    )
    report(
        "chat_invite_links with use_count > max_uses",
        "SELECT count(*) FROM chat_invite_links WHERE max_uses IS NOT NULL AND use_count > max_uses",
        "SELECT id FROM chat_invite_links WHERE max_uses IS NOT NULL AND use_count > max_uses "
        "ORDER BY id",
    )
    report(
        "contacts that point at their own owner (owner_id)",
        "SELECT count(*) FROM contacts WHERE owner_id = contact_id",
        "SELECT owner_id FROM contacts WHERE owner_id = contact_id ORDER BY owner_id",
    )
    return problems


def upgrade() -> None:
    problems = _violations()
    if problems:
        raise RuntimeError(
            "Migration d4e2f6b8c013 aborted: existing rows do not satisfy the new constraints. "
            "Nothing was changed. Fix or delete these rows, then run the migration again:\n"
            + "\n".join(problems)
        )

    # TB-25: renumber the (rare) packs that already hold duplicate positions.
    op.execute(
        """
        UPDATE stickers s
        SET position = r.new_position
        FROM (
            SELECT id, row_number() OVER (PARTITION BY pack_id ORDER BY position, id) - 1 AS new_position
            FROM stickers
            WHERE pack_id IN (
                SELECT pack_id FROM stickers GROUP BY pack_id HAVING count(*) <> count(DISTINCT position)
            )
        ) r
        WHERE s.id = r.id AND s.position <> r.new_position
        """
    )

    # TB-22
    op.create_unique_constraint('uq_chat_key_epochs_id_chat', 'chat_key_epochs', ['id', 'chat_id'])
    op.create_index(
        'uq_open_epoch_per_chat', 'chat_key_epochs', ['chat_id'],
        unique=True, postgresql_where=sa.text('closed_at IS NULL'),
    )
    op.execute('ALTER TABLE sender_key_distributions DROP CONSTRAINT IF EXISTS sender_key_distributions_epoch_id_fkey')
    op.create_foreign_key(
        'fk_skd_epoch_chat', 'sender_key_distributions', 'chat_key_epochs',
        ['epoch_id', 'chat_id'], ['id', 'chat_id'], ondelete='CASCADE',
    )

    # TB-23
    op.create_index('ix_grant_recipient_device', 'sender_key_grants', ['recipient_device_id'])
    op.create_index('ix_grant_recipient_identity_key', 'sender_key_grants', ['recipient_identity_key_id'])
    op.create_index('ix_chats_updated_at', 'chats', [sa.text('updated_at DESC')])

    # TB-25
    op.create_check_constraint(
        'ck_invite_links_use_count_le_max', 'chat_invite_links',
        'max_uses IS NULL OR use_count <= max_uses',
    )
    op.create_check_constraint('ck_contacts_not_self', 'contacts', 'owner_id <> contact_id')
    op.create_unique_constraint('uq_stickers_pack_position', 'stickers', ['pack_id', 'position'])


def downgrade() -> None:
    op.drop_constraint('uq_stickers_pack_position', 'stickers', type_='unique')
    op.drop_constraint('ck_contacts_not_self', 'contacts', type_='check')
    op.drop_constraint('ck_invite_links_use_count_le_max', 'chat_invite_links', type_='check')

    op.drop_index('ix_chats_updated_at', table_name='chats')
    op.drop_index('ix_grant_recipient_identity_key', table_name='sender_key_grants')
    op.drop_index('ix_grant_recipient_device', table_name='sender_key_grants')

    op.drop_constraint('fk_skd_epoch_chat', 'sender_key_distributions', type_='foreignkey')
    op.create_foreign_key(
        'sender_key_distributions_epoch_id_fkey', 'sender_key_distributions', 'chat_key_epochs',
        ['epoch_id'], ['id'], ondelete='CASCADE',
    )
    op.drop_index('uq_open_epoch_per_chat', table_name='chat_key_epochs')
    op.drop_constraint('uq_chat_key_epochs_id_chat', 'chat_key_epochs', type_='unique')
