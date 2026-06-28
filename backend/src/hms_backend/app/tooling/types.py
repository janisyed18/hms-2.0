from typing import TypedDict


class CustomerFixture(TypedDict, total=False):
    legacy_id: str
    code: str
    name: str
    address_1: str
    address_2: str
    city: str
    state: str
    country: str
    email: str
    hms_retest: bool
    retest_month: int


class AssetFixture(TypedDict, total=False):
    legacy_id: str
    customer_code: str
    asset_id: str
    customer_serial_no: str
    location: str
    product_code: str
    length_m: str
    nominal_bore: str
    manufacture_date: str
    grave_date: str


class ProductFixture(TypedDict, total=False):
    legacy_id: str
    category: str
    sub_category: str
    name: str
    code: str
    standard: str


class SyntheticDataset(TypedDict):
    schema_version: str
    customers: list[CustomerFixture]
    assets: list[AssetFixture]
    products: list[ProductFixture]
