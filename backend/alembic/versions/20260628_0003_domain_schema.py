"""core HMS domain schema

Revision ID: 20260628_0003
Revises: 20260628_0002
Create Date: 2026-06-28
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260628_0003"
down_revision: str | None = "20260628_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def syncable_columns() -> list[sa.Column[object]]:
    return [
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("legacy_system", sa.String(length=80), nullable=True),
        sa.Column("legacy_table", sa.String(length=80), nullable=True),
        sa.Column("legacy_id", sa.String(length=120), nullable=True),
        sa.Column("legacy_payload", sa.JSON(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    ]


def lookup_columns() -> list[sa.Column[object]]:
    return [
        sa.Column("code", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("code"),
        *syncable_columns(),
    ]


def upgrade() -> None:
    op.add_column(
        "customers",
        sa.Column(
            "retest_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "customers",
        sa.Column("default_retest_months", sa.Integer(), nullable=True),
    )

    op.create_table("couplings", *lookup_columns())
    op.create_table("coupling_add_ons", *lookup_columns())
    op.create_table("attach_methods", *lookup_columns())
    op.create_table("materials", *lookup_columns())
    op.create_table(
        "nominal_bores",
        sa.Column("code", sa.String(length=80), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("code"),
        *syncable_columns(),
    )
    op.create_table("standards", *lookup_columns())

    op.create_table(
        "customer_locations",
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("address_1", sa.String(length=240), nullable=True),
        sa.Column("address_2", sa.String(length=240), nullable=True),
        sa.Column("city", sa.String(length=120), nullable=True),
        sa.Column("state", sa.String(length=80), nullable=True),
        sa.Column("country", sa.String(length=80), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
    )
    op.create_index(
        "ix_customer_locations_customer_id",
        "customer_locations",
        ["customer_id"],
    )

    op.create_table(
        "customer_contacts",
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("phone", sa.String(length=80), nullable=True),
        sa.Column("role", sa.String(length=120), nullable=True),
        sa.Column("receives_retest_reminders", sa.Boolean(), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
    )
    op.create_index(
        "ix_customer_contacts_customer_id",
        "customer_contacts",
        ["customer_id"],
    )

    op.create_table(
        "products",
        sa.Column("category", sa.String(length=120), nullable=False),
        sa.Column("sub_category", sa.String(length=120), nullable=True),
        sa.Column("code", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("product_type", sa.String(length=120), nullable=True),
        sa.Column("grade", sa.String(length=120), nullable=True),
        sa.Column("kind", sa.String(length=120), nullable=True),
        sa.Column("test_code", sa.String(length=80), nullable=True),
        sa.Column("standard_id", sa.String(length=36), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["standard_id"], ["standards.id"]),
    )
    op.create_index("ix_products_category", "products", ["category"])
    op.create_index("ix_products_code", "products", ["code"])
    op.create_index("ix_products_standard_id", "products", ["standard_id"])

    op.create_table(
        "product_pressure_ratings",
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("nominal_bore_id", sa.String(length=36), nullable=False),
        sa.Column("working_pressure_kpa", sa.Integer(), nullable=False),
        sa.Column("test_pressure_kpa", sa.Integer(), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["nominal_bore_id"], ["nominal_bores.id"]),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.UniqueConstraint(
            "product_id",
            "nominal_bore_id",
            name="uq_product_pressure_rating_product_bore",
        ),
    )
    op.create_index(
        "ix_product_pressure_ratings_nominal_bore_id",
        "product_pressure_ratings",
        ["nominal_bore_id"],
    )
    op.create_index(
        "ix_product_pressure_ratings_product_id",
        "product_pressure_ratings",
        ["product_id"],
    )

    op.create_table(
        "assets",
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("location_id", sa.String(length=36), nullable=True),
        sa.Column("product_id", sa.String(length=36), nullable=False),
        sa.Column("asset_number", sa.String(length=80), nullable=False),
        sa.Column("customer_serial_no", sa.String(length=120), nullable=True),
        sa.Column("tag", sa.String(length=120), nullable=True),
        sa.Column("lifecycle_status", sa.String(length=40), nullable=False),
        sa.Column("manufacture_date", sa.Date(), nullable=True),
        sa.Column("next_retest_due_at", sa.Date(), nullable=True),
        sa.Column("condemned_at", sa.Date(), nullable=True),
        sa.Column("length_m", sa.Numeric(10, 3), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["location_id"], ["customer_locations.id"]),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.UniqueConstraint("asset_number"),
        sa.UniqueConstraint("tag"),
    )
    op.create_index("ix_assets_customer_id", "assets", ["customer_id"])
    op.create_index("ix_assets_location_id", "assets", ["location_id"])
    op.create_index("ix_assets_product_id", "assets", ["product_id"])

    op.create_table(
        "asset_end_configurations",
        sa.Column("asset_id", sa.String(length=36), nullable=False),
        sa.Column("end", sa.String(length=1), nullable=False),
        sa.Column("nominal_bore_id", sa.String(length=36), nullable=True),
        sa.Column("material_id", sa.String(length=36), nullable=True),
        sa.Column("coupling_id", sa.String(length=36), nullable=True),
        sa.Column("coupling_add_on_id", sa.String(length=36), nullable=True),
        sa.Column("attach_method_id", sa.String(length=36), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.ForeignKeyConstraint(["attach_method_id"], ["attach_methods.id"]),
        sa.ForeignKeyConstraint(["coupling_add_on_id"], ["coupling_add_ons.id"]),
        sa.ForeignKeyConstraint(["coupling_id"], ["couplings.id"]),
        sa.ForeignKeyConstraint(["material_id"], ["materials.id"]),
        sa.ForeignKeyConstraint(["nominal_bore_id"], ["nominal_bores.id"]),
        sa.UniqueConstraint("asset_id", "end", name="uq_asset_end_config_asset_end"),
    )
    op.create_index(
        "ix_asset_end_configurations_asset_id",
        "asset_end_configurations",
        ["asset_id"],
    )
    op.create_index(
        "ix_asset_end_configurations_attach_method_id",
        "asset_end_configurations",
        ["attach_method_id"],
    )
    op.create_index(
        "ix_asset_end_configurations_coupling_add_on_id",
        "asset_end_configurations",
        ["coupling_add_on_id"],
    )
    op.create_index(
        "ix_asset_end_configurations_coupling_id",
        "asset_end_configurations",
        ["coupling_id"],
    )
    op.create_index(
        "ix_asset_end_configurations_material_id",
        "asset_end_configurations",
        ["material_id"],
    )
    op.create_index(
        "ix_asset_end_configurations_nominal_bore_id",
        "asset_end_configurations",
        ["nominal_bore_id"],
    )

    op.create_table(
        "inspection_templates",
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("inspection_type", sa.String(length=40), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        *syncable_columns(),
    )
    op.create_table(
        "inspection_questions",
        sa.Column("template_id", sa.String(length=36), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("response_type", sa.String(length=40), nullable=False),
        sa.Column("required", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["template_id"], ["inspection_templates.id"]),
    )
    op.create_index(
        "ix_inspection_questions_template_id",
        "inspection_questions",
        ["template_id"],
    )

    op.create_table(
        "inspections",
        sa.Column("asset_id", sa.String(length=36), nullable=False),
        sa.Column("inspection_type", sa.String(length=40), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("result", sa.String(length=40), nullable=True),
        sa.Column("inspector_user_id", sa.String(length=36), nullable=False),
        sa.Column("reviewer_user_id", sa.String(length=36), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
    )
    op.create_index("ix_inspections_asset_id", "inspections", ["asset_id"])

    op.create_table(
        "inspection_answers",
        sa.Column("inspection_id", sa.String(length=36), nullable=False),
        sa.Column("question_id", sa.String(length=36), nullable=True),
        sa.Column("answer", sa.JSON(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["inspection_id"], ["inspections.id"]),
        sa.ForeignKeyConstraint(["question_id"], ["inspection_questions.id"]),
    )
    op.create_index(
        "ix_inspection_answers_inspection_id",
        "inspection_answers",
        ["inspection_id"],
    )
    op.create_index(
        "ix_inspection_answers_question_id",
        "inspection_answers",
        ["question_id"],
    )

    op.create_table(
        "pressure_test_results",
        sa.Column("inspection_id", sa.String(length=36), nullable=False),
        sa.Column("applied_pressure_kpa", sa.Integer(), nullable=False),
        sa.Column("hold_time_seconds", sa.Integer(), nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=False),
        sa.Column("measurements", sa.JSON(), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["inspection_id"], ["inspections.id"]),
        sa.UniqueConstraint("inspection_id"),
    )
    op.create_table(
        "inspection_photos",
        sa.Column("inspection_id", sa.String(length=36), nullable=False),
        sa.Column("object_key", sa.String(length=500), nullable=False),
        sa.Column("caption", sa.String(length=240), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["inspection_id"], ["inspections.id"]),
    )
    op.create_index(
        "ix_inspection_photos_inspection_id",
        "inspection_photos",
        ["inspection_id"],
    )

    op.create_table(
        "certificates",
        sa.Column("inspection_id", sa.String(length=36), nullable=False),
        sa.Column("asset_id", sa.String(length=36), nullable=False),
        sa.Column("number", sa.String(length=120), nullable=False),
        sa.Column("certificate_version", sa.Integer(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("valid_until", sa.Date(), nullable=True),
        sa.Column("pdf_object_key", sa.String(length=500), nullable=False),
        sa.Column("verification_hash", sa.String(length=128), nullable=False),
        sa.Column("public_token", sa.String(length=160), nullable=False),
        sa.Column("issued_by_user_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.ForeignKeyConstraint(["inspection_id"], ["inspections.id"]),
        sa.UniqueConstraint("inspection_id"),
        sa.UniqueConstraint("number"),
        sa.UniqueConstraint("public_token"),
        sa.UniqueConstraint("verification_hash"),
    )
    op.create_index("ix_certificates_asset_id", "certificates", ["asset_id"])

    op.create_table(
        "retest_schedules",
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("asset_id", sa.String(length=36), nullable=False),
        sa.Column("due_at", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("reminder_interval_days", sa.Integer(), nullable=False),
        sa.Column("escalation_interval_days", sa.Integer(), nullable=False),
        sa.Column("last_reminded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("escalated_at", sa.DateTime(timezone=True), nullable=True),
        *syncable_columns(),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.UniqueConstraint("asset_id"),
    )
    op.create_index(
        "ix_retest_schedules_customer_id",
        "retest_schedules",
        ["customer_id"],
    )
    op.create_index("ix_retest_schedules_due_at", "retest_schedules", ["due_at"])


def downgrade() -> None:
    op.drop_index("ix_retest_schedules_due_at", table_name="retest_schedules")
    op.drop_index("ix_retest_schedules_customer_id", table_name="retest_schedules")
    op.drop_table("retest_schedules")
    op.drop_index("ix_certificates_asset_id", table_name="certificates")
    op.drop_table("certificates")
    op.drop_index("ix_inspection_photos_inspection_id", table_name="inspection_photos")
    op.drop_table("inspection_photos")
    op.drop_table("pressure_test_results")
    op.drop_index("ix_inspection_answers_question_id", table_name="inspection_answers")
    op.drop_index(
        "ix_inspection_answers_inspection_id",
        table_name="inspection_answers",
    )
    op.drop_table("inspection_answers")
    op.drop_index("ix_inspections_asset_id", table_name="inspections")
    op.drop_table("inspections")
    op.drop_index(
        "ix_inspection_questions_template_id",
        table_name="inspection_questions",
    )
    op.drop_table("inspection_questions")
    op.drop_table("inspection_templates")
    op.drop_index(
        "ix_asset_end_configurations_nominal_bore_id",
        table_name="asset_end_configurations",
    )
    op.drop_index(
        "ix_asset_end_configurations_material_id",
        table_name="asset_end_configurations",
    )
    op.drop_index(
        "ix_asset_end_configurations_coupling_id",
        table_name="asset_end_configurations",
    )
    op.drop_index(
        "ix_asset_end_configurations_coupling_add_on_id",
        table_name="asset_end_configurations",
    )
    op.drop_index(
        "ix_asset_end_configurations_attach_method_id",
        table_name="asset_end_configurations",
    )
    op.drop_index(
        "ix_asset_end_configurations_asset_id",
        table_name="asset_end_configurations",
    )
    op.drop_table("asset_end_configurations")
    op.drop_index("ix_assets_product_id", table_name="assets")
    op.drop_index("ix_assets_location_id", table_name="assets")
    op.drop_index("ix_assets_customer_id", table_name="assets")
    op.drop_table("assets")
    op.drop_index(
        "ix_product_pressure_ratings_product_id",
        table_name="product_pressure_ratings",
    )
    op.drop_index(
        "ix_product_pressure_ratings_nominal_bore_id",
        table_name="product_pressure_ratings",
    )
    op.drop_table("product_pressure_ratings")
    op.drop_index("ix_products_standard_id", table_name="products")
    op.drop_index("ix_products_code", table_name="products")
    op.drop_index("ix_products_category", table_name="products")
    op.drop_table("products")
    op.drop_index("ix_customer_contacts_customer_id", table_name="customer_contacts")
    op.drop_table("customer_contacts")
    op.drop_index("ix_customer_locations_customer_id", table_name="customer_locations")
    op.drop_table("customer_locations")
    op.drop_table("standards")
    op.drop_table("nominal_bores")
    op.drop_table("materials")
    op.drop_table("attach_methods")
    op.drop_table("coupling_add_ons")
    op.drop_table("couplings")
    op.drop_column("customers", "default_retest_months")
    op.drop_column("customers", "retest_enabled")
