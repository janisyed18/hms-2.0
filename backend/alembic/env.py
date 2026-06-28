from __future__ import annotations

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context
from hms_backend.app.core.config import settings
from hms_backend.app.models import foundation  # noqa: F401
from hms_backend.app.models.base import Base
from hms_backend.app.modules.assets import models as asset_models  # noqa: F401
from hms_backend.app.modules.certificates import (  # noqa: F401
    models as certificate_models,
)
from hms_backend.app.modules.customers import models as customer_models  # noqa: F401
from hms_backend.app.modules.identity import models as identity_models  # noqa: F401
from hms_backend.app.modules.inspections import (  # noqa: F401
    models as inspection_models,
)
from hms_backend.app.modules.products import models as product_models  # noqa: F401
from hms_backend.app.modules.reference import models as reference_models  # noqa: F401
from hms_backend.app.modules.scheduling import (  # noqa: F401
    models as scheduling_models,
)

config = context.config
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


run_migrations_online()
