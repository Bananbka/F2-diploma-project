"""fixed-width crypto columns with CHECK constraints (TB-21)

Revision ID: c3d1e5a7b902
Revises: f7af24530412
Create Date: 2026-10-25

Public keys are 32 raw bytes (43 base64url chars), signatures 64 (86 chars), the member-set hash is
a lowercase SHA-256 hex digest (64 chars) and the read-state markers are Mongo ObjectIds (24 hex
chars). They were `text`/`varchar`, so nothing stopped a short, long or malformed value from being
stored, and a bug upstream of the schema validators would have surfaced much later as a verification
failure on someone else's device. The columns become `char(n)` and every one gains a CHECK. `char(n)`
alone is not enough: Postgres pads a short value with spaces instead of rejecting it.

Applying a constraint to data that already violates it fails with an unhelpful constraint error that
names no rows. This migration therefore checks first and, on any offender, aborts before touching the
schema with the table, the column and the ids of the offending rows.

No enum types are created, so `downgrade()` has nothing to drop in `pg_type`.
"""
from alembic import op
import sqlalchemy as sa

revision = 'c3d1e5a7b902'
down_revision = 'f7af24530412'
branch_labels = None
depends_on = None

# (table, column, width, nullable)
FIXED_WIDTH = [
    ("user_identity_keys", "identity_public_key", 43, False, "ck_identity_key_identity_public_len"),
    ("user_identity_keys", "signing_public_key", 43, False, "ck_identity_key_signing_public_len"),
    ("user_identity_keys", "identity_key_signature", 86, False, "ck_identity_key_signature_len"),
    ("user_identity_keys", "signed_prekey_public", 43, True, "ck_identity_key_prekey_public_len"),
    ("user_identity_keys", "signed_prekey_signature", 86, True, "ck_identity_key_prekey_signature_len"),
    ("sender_key_distributions", "signing_public_key", 43, False, "ck_skd_signing_public_len"),
    ("sender_key_distributions", "signature", 86, False, "ck_skd_signature_len"),
    ("sender_key_grants", "ephemeral_public_key", 43, False, "ck_grant_ephemeral_public_len"),
]

# (table, column, width, regex, constraint, nullable, original SQLAlchemy type for downgrade)
PATTERNED = [
    ("chat_key_epochs", "member_set_hash", 64, "^[0-9a-f]{64}$",
     "ck_chat_key_epochs_member_set_hash", False, sa.Text()),
    ("chat_participants", "last_read_message_id", 24, "^[0-9a-f]{24}$",
     "ck_participant_last_read_objectid", True, sa.String()),
    ("chat_participants", "history_start_message_id", 24, "^[0-9a-f]{24}$",
     "ck_participant_history_start_objectid", True, sa.String()),
]

SAMPLE = 20


def _violations() -> list[str]:
    bind = op.get_bind()
    problems: list[str] = []

    def collect(table: str, column: str, predicate: str, expectation: str) -> None:
        count = bind.execute(sa.text(f"SELECT count(*) FROM {table} WHERE {predicate}")).scalar()
        if not count:
            return
        ids = bind.execute(
            sa.text(f"SELECT id FROM {table} WHERE {predicate} ORDER BY id LIMIT {SAMPLE}")
        ).scalars().all()
        more = f" (+{count - len(ids)} more)" if count > len(ids) else ""
        problems.append(
            f"  {table}.{column}: {count} row(s) violate {expectation}; "
            f"ids: {', '.join(str(i) for i in ids)}{more}"
        )

    # The charset is checked as well as the length: `char(n)` drops trailing spaces on comparison,
    # so a value of n-1 characters plus a space has length n as text but would be rejected by the
    # CHECK after the cast, failing the migration half-way with an unhelpful message.
    for table, column, width, nullable, _name in FIXED_WIDTH:
        pattern = f"^[A-Za-z0-9_-]{{{width}}}$"
        predicate = f"{column} IS NOT NULL AND {column} !~ '{pattern}'"
        if not nullable:
            predicate = f"{column} IS NULL OR {column} !~ '{pattern}'"
        collect(table, column, predicate, f"{width} base64url characters")

    for table, column, width, regex, _name, nullable, _type in PATTERNED:
        predicate = f"{column} IS NOT NULL AND {column} !~ '{regex}'"
        if not nullable:
            predicate = f"{column} IS NULL OR {column} !~ '{regex}'"
        collect(table, column, predicate, f"pattern {regex}")

    return problems


def upgrade() -> None:
    problems = _violations()
    if problems:
        raise RuntimeError(
            "Migration c3d1e5a7b902 aborted: existing rows do not satisfy the new constraints. "
            "Nothing was changed. Fix or delete these rows, then run the migration again:\n"
            + "\n".join(problems)
        )

    for table, column, width, nullable, name in FIXED_WIDTH:
        op.alter_column(
            table, column, type_=sa.CHAR(width), existing_nullable=nullable,
            postgresql_using=f"{column}::char({width})",
        )
        op.create_check_constraint(
            name, table, f"length({column}) = {width}" if not nullable
            else f"{column} IS NULL OR length({column}) = {width}",
        )

    for table, column, width, regex, name, nullable, _type in PATTERNED:
        op.alter_column(
            table, column, type_=sa.CHAR(width), existing_nullable=nullable,
            postgresql_using=f"{column}::char({width})",
        )
        op.create_check_constraint(
            name, table,
            f"{column} ~ '{regex}'" if not nullable
            else f"{column} IS NULL OR {column} ~ '{regex}'",
        )


def downgrade() -> None:
    for table, column, _width, regex, name, nullable, original in PATTERNED:
        op.drop_constraint(name, table, type_="check")
        op.alter_column(
            table, column, type_=original, existing_nullable=nullable,
            postgresql_using=f"{column}::{'text' if isinstance(original, sa.Text) else 'varchar'}",
        )

    for table, column, _width, nullable, name in FIXED_WIDTH:
        op.drop_constraint(name, table, type_="check")
        op.alter_column(
            table, column, type_=sa.Text(), existing_nullable=nullable,
            postgresql_using=f"{column}::text",
        )
