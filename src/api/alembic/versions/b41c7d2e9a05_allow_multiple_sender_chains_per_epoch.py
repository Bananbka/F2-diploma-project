"""allow multiple sender chains per device per epoch

Revision ID: b41c7d2e9a05
Revises: 9aa1a30c6412
Create Date: 2026-08-02

`uq_skd_epoch_sender_device` allowed one distribution per (epoch, sender device). That encoded an
assumption no client can honour: chain state is secret, lives only in memory, and is gone after a
page reload. On the next send the client must mint a fresh chain, and publishing it violated the
constraint — so every send after a reload returned 500 and the chat became unsendable for the rest
of the epoch.

Relaxing it is safe, and the rest of the design already assumes it:

  * A chain is identified by `sender_key_id`, which `uq_skd_chat_sender_key_id` still keeps unique.
  * Receivers key their chains on (chat, epoch, sender_key_id) and select one per message via the
    envelope's `skid`, so several concurrent chains from one sender already work.
  * Each new chain has its own random chain key, so restarting at index 0 reuses no message key.
    Nonce and key reuse — the real hazard — is avoided by the new key, not by the constraint.

Deleting the superseded row instead would have been worse: its grants would go with it and every
message already sent under it would become permanently unreadable.
"""
from alembic import op

revision = 'b41c7d2e9a05'
down_revision = '9aa1a30c6412'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint('uq_skd_epoch_sender_device', 'sender_key_distributions', type_='unique')


def downgrade() -> None:
    # Re-creating the constraint fails if any device now holds more than one chain in an epoch,
    # which is the normal state after any client reload. Collapse to the newest chain per
    # (epoch, device) first so the downgrade is actually runnable.
    op.execute(
        """
        DELETE FROM sender_key_distributions d
        USING sender_key_distributions newer
        WHERE d.epoch_id = newer.epoch_id
          AND d.sender_device_id = newer.sender_device_id
          AND d.created_at < newer.created_at
        """
    )
    op.create_unique_constraint(
        'uq_skd_epoch_sender_device',
        'sender_key_distributions',
        ['epoch_id', 'sender_device_id'],
    )
