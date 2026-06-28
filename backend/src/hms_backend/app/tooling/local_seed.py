from __future__ import annotations

import asyncio
import json
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hms_backend.app.core.repository import record_create
from hms_backend.app.modules.assets.models import Asset
from hms_backend.app.modules.customers.models import (
    Customer,
    CustomerContact,
    CustomerLocation,
)
from hms_backend.app.modules.products.models import Product
from hms_backend.app.modules.reference.models import Standard
from hms_backend.app.modules.scheduling.models import RetestSchedule
from hms_backend.app.tooling.migration import build_domain_import_plan
from hms_backend.app.tooling.synthetic import generate_clean_dataset

SeedSummary = dict[str, int]

SEED_ACTOR_ID = "local-seed"


async def seed_local_demo_data(
    session: AsyncSession,
    *,
    today: date | None = None,
) -> SeedSummary:
    plan = build_domain_import_plan(generate_clean_dataset(), today=today)

    standards_by_code = await _seed_standards(session, plan)
    customers_by_code = await _seed_customers(session, plan)
    locations_by_customer_code = await _seed_customer_locations(
        session,
        plan,
        customers_by_code,
    )
    await _seed_customer_contacts(session, plan, customers_by_code)
    products_by_code = await _seed_products(session, plan, standards_by_code)
    assets_by_number = await _seed_assets(
        session,
        plan,
        customers_by_code,
        locations_by_customer_code,
        products_by_code,
    )
    await _seed_retest_schedules(
        session,
        plan,
        customers_by_code,
        assets_by_number,
    )

    await session.commit()
    return {
        "standards": len(standards_by_code),
        **plan.table_counts,
    }


async def _seed_standards(session: AsyncSession, plan: Any) -> dict[str, Standard]:
    standard_codes = sorted(
        {
            product.standard_code
            for product in plan.products
            if product.standard_code is not None
        }
    )
    standards_by_code: dict[str, Standard] = {}
    for code in standard_codes:
        standard = await _scalar_one_or_none(
            session,
            select(Standard).where(Standard.code == code),
        )
        if standard is None:
            standard = Standard(code=code, name=code, enabled=True)
            session.add(standard)
            await record_create(
                session,
                standard,
                actor_id=SEED_ACTOR_ID,
                action="standard.seeded",
            )
        standards_by_code[code] = standard
    return standards_by_code


async def _seed_customers(session: AsyncSession, plan: Any) -> dict[str, Customer]:
    customers_by_code: dict[str, Customer] = {}
    for row in plan.customers:
        customer = await _scalar_one_or_none(
            session,
            select(Customer).where(Customer.code == row.code),
        )
        if customer is None:
            customer = Customer(
                code=row.code,
                name=row.name,
                retest_enabled=row.retest_enabled,
                default_retest_months=row.default_retest_months,
                legacy_system="synthetic",
                legacy_table="customers",
                legacy_id=row.legacy_id,
            )
            session.add(customer)
            await record_create(
                session,
                customer,
                actor_id=SEED_ACTOR_ID,
                action="customer.seeded",
            )
        customers_by_code[row.code] = customer
    return customers_by_code


async def _seed_customer_locations(
    session: AsyncSession,
    plan: Any,
    customers_by_code: dict[str, Customer],
) -> dict[str, CustomerLocation]:
    locations_by_customer_code: dict[str, CustomerLocation] = {}
    for row in plan.customer_locations:
        customer = customers_by_code[row.customer_code]
        location = await _scalar_one_or_none(
            session,
            select(CustomerLocation).where(
                CustomerLocation.customer_id == customer.id,
                CustomerLocation.name == row.name,
            ),
        )
        if location is None:
            location = CustomerLocation(
                customer=customer,
                name=row.name,
                address_1=row.address_1,
                address_2=row.address_2,
                city=row.city,
                state=row.state,
                country=row.country,
            )
            session.add(location)
            await record_create(
                session,
                location,
                actor_id=SEED_ACTOR_ID,
                action="customer_location.seeded",
            )
        locations_by_customer_code[row.customer_code] = location
    return locations_by_customer_code


async def _seed_customer_contacts(
    session: AsyncSession,
    plan: Any,
    customers_by_code: dict[str, Customer],
) -> None:
    for row in plan.customer_contacts:
        customer = customers_by_code[row.customer_code]
        contact = await _scalar_one_or_none(
            session,
            select(CustomerContact).where(
                CustomerContact.customer_id == customer.id,
                CustomerContact.name == row.name,
            ),
        )
        if contact is None:
            contact = CustomerContact(
                customer=customer,
                name=row.name,
                email=row.email,
                receives_retest_reminders=row.receives_retest_reminders,
            )
            session.add(contact)
            await record_create(
                session,
                contact,
                actor_id=SEED_ACTOR_ID,
                action="customer_contact.seeded",
            )


async def _seed_products(
    session: AsyncSession,
    plan: Any,
    standards_by_code: dict[str, Standard],
) -> dict[str, Product]:
    products_by_code: dict[str, Product] = {}
    for row in plan.products:
        product = await _scalar_one_or_none(
            session,
            select(Product).where(Product.code == row.code),
        )
        if product is None:
            product = Product(
                category=row.category,
                sub_category=row.sub_category,
                code=row.code,
                name=row.name,
                standard=(
                    standards_by_code[row.standard_code]
                    if row.standard_code is not None
                    else None
                ),
                enabled=row.enabled,
                legacy_system="synthetic",
                legacy_table="products",
                legacy_id=row.legacy_id,
            )
            session.add(product)
            await record_create(
                session,
                product,
                actor_id=SEED_ACTOR_ID,
                action="product.seeded",
            )
        products_by_code[row.code] = product
    return products_by_code


async def _seed_assets(
    session: AsyncSession,
    plan: Any,
    customers_by_code: dict[str, Customer],
    locations_by_customer_code: dict[str, CustomerLocation],
    products_by_code: dict[str, Product],
) -> dict[str, Asset]:
    assets_by_number: dict[str, Asset] = {}
    for row in plan.assets:
        asset = await _scalar_one_or_none(
            session,
            select(Asset).where(Asset.asset_number == row.asset_number),
        )
        if asset is None:
            asset = Asset(
                customer=customers_by_code[row.customer_code],
                location=locations_by_customer_code.get(row.customer_code),
                product=products_by_code[row.product_code],
                asset_number=row.asset_number,
                customer_serial_no=row.customer_serial_no,
                tag=row.tag,
                lifecycle_status=row.lifecycle_status,
                manufacture_date=row.manufacture_date,
                next_retest_due_at=row.next_retest_due_at,
                condemned_at=row.condemned_at,
                length_m=Decimal(row.length_m) if row.length_m is not None else None,
                legacy_system="synthetic",
                legacy_table="assets",
                legacy_id=row.legacy_id,
            )
            session.add(asset)
            await record_create(
                session,
                asset,
                actor_id=SEED_ACTOR_ID,
                action="asset.seeded",
            )
        assets_by_number[row.asset_number] = asset
    return assets_by_number


async def _seed_retest_schedules(
    session: AsyncSession,
    plan: Any,
    customers_by_code: dict[str, Customer],
    assets_by_number: dict[str, Asset],
) -> None:
    for row in plan.retest_schedules:
        asset = assets_by_number[row.asset_number]
        schedule = await _scalar_one_or_none(
            session,
            select(RetestSchedule).where(RetestSchedule.asset_id == asset.id),
        )
        if schedule is None:
            schedule = RetestSchedule(
                customer=customers_by_code[row.customer_code],
                asset=asset,
                due_at=row.due_at,
                status=row.status,
                reminder_interval_days=row.reminder_interval_days,
                escalation_interval_days=row.escalation_interval_days,
            )
            session.add(schedule)
            await record_create(
                session,
                schedule,
                actor_id=SEED_ACTOR_ID,
                action="retest_schedule.seeded",
            )


async def _scalar_one_or_none(session: AsyncSession, statement: Any) -> Any | None:
    result = await session.scalar(statement)
    return result


async def _count(session: AsyncSession, model: type[Any]) -> int:
    return await session.scalar(select(func.count()).select_from(model)) or 0


async def seed_configured_database() -> SeedSummary:
    from hms_backend.app.api.dependencies import SessionLocal

    async with SessionLocal() as session:
        await seed_local_demo_data(session)
        return {
            "standards": await _count(session, Standard),
            "customers": await _count(session, Customer),
            "customer_locations": await _count(session, CustomerLocation),
            "customer_contacts": await _count(session, CustomerContact),
            "products": await _count(session, Product),
            "assets": await _count(session, Asset),
            "retest_schedules": await _count(session, RetestSchedule),
        }


def main() -> None:
    summary = asyncio.run(seed_configured_database())
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
