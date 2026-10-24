"""index inspection bookings by scheduled time

The Staff scheduling calendar reads bookings by a bounded time range. Without an
index on ``scheduled_at`` PostgreSQL scans the whole table for every calendar view
(about 42 ms and 2,700 buffers at 150,000 rows, against about 2 ms and 29 buffers
with the index and the range lower bound the query adds).

On PostgreSQL the index is built and dropped ``CONCURRENTLY``: a migration runs while
the previous API is still serving traffic, and a plain ``CREATE INDEX`` would block
every write to ``inspection_bookings`` for the whole build. ``CONCURRENTLY`` cannot run
inside a transaction, so the statements run in an ``autocommit_block`` (which first
commits whatever this migration run has already done). If a concurrent build is
interrupted PostgreSQL leaves an INVALID index behind; that is detected and rebuilt
rather than mistaken for a finished one. Other dialects (SQLite in tests) use the plain
statements.

Revision ID: 20261023_0023
Revises: 20261022_0022
Create Date: 2026-10-23
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261023_0023"
down_revision: str | None = "20261022_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | None = None

INDEX = "ix_inspection_bookings_scheduled_at"
TABLE = "inspection_bookings"


def _is_postgresql() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _index_state() -> bool | None:
    """None when absent, else whether PostgreSQL considers the index valid."""
    return (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT i.indisvalid FROM pg_index i "
                "JOIN pg_class c ON c.oid = i.indexrelid "
                "WHERE c.relname = :name "
            "AND c.relnamespace = current_schema()::regnamespace"
            ),
            {"name": INDEX},
        )
        .scalar()
    )


def upgrade() -> None:
    if not _is_postgresql():
        op.create_index(INDEX, TABLE, ["scheduled_at"])
        return
    with op.get_context().autocommit_block():
        state = _index_state()
        if state is False:
            # An earlier concurrent build was interrupted and left an unusable index.
            op.drop_index(INDEX, table_name=TABLE, postgresql_concurrently=True)
        if state is not True:
            op.create_index(
                INDEX, TABLE, ["scheduled_at"], postgresql_concurrently=True
            )


def downgrade() -> None:
    if not _is_postgresql():
        op.drop_index(INDEX, table_name=TABLE)
        return
    with op.get_context().autocommit_block():
        op.drop_index(
            INDEX, table_name=TABLE, postgresql_concurrently=True, if_exists=True
        )
