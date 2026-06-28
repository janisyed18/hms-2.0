from __future__ import annotations

import json
from pathlib import Path

from hms_backend.app.tooling.types import SyntheticDataset


def generate_clean_dataset() -> SyntheticDataset:
    return {
        "schema_version": "hms.synthetic.v1",
        "customers": [
            {
                "legacy_id": "39733",
                "code": "VOPA",
                "name": "Vopak",
                "address_1": "Site A 49 Friendship Road",
                "address_2": "Site B 20 Friendship Road",
                "city": "Port Botany",
                "state": "NSW",
                "country": "AU",
                "email": "safety.officer+vopa@example.invalid",
                "hms_retest": True,
                "retest_month": 6,
            },
            {
                "legacy_id": "43696",
                "code": "ORIC",
                "name": "Orica Mining Services",
                "city": "Kooragang",
                "state": "NSW",
                "country": "AU",
                "email": "maintenance+oric@example.invalid",
                "hms_retest": True,
                "retest_month": 6,
            },
            {
                "legacy_id": "40855",
                "code": "LINFOX",
                "name": "LINFOX AUSTRALIA PTY LTD",
                "city": "Erskine Park",
                "state": "NSW",
                "country": "AU",
                "email": "fleet+linfox@example.invalid",
                "hms_retest": True,
                "retest_month": 7,
            },
        ],
        "assets": [
            {
                "legacy_id": "997950",
                "customer_code": "VOPA",
                "asset_id": "997950",
                "customer_serial_no": "",
                "location": "Site A",
                "product_code": "1000GY",
                "length_m": "6.100",
                "nominal_bore": "75NB",
                "manufacture_date": "2023-05-02",
                "grave_date": "2028-05-02",
            },
            {
                "legacy_id": "980636",
                "customer_code": "VOPA",
                "asset_id": "980636",
                "customer_serial_no": "",
                "location": "Site A",
                "product_code": "1000GY",
                "length_m": "6.100",
                "nominal_bore": "75NB",
                "manufacture_date": "2014-07-08",
                "grave_date": "2019-07-08",
            },
        ],
        "products": [
            {
                "legacy_id": "95",
                "category": "Composite",
                "sub_category": "Petrol & Oil",
                "name": "FUELFLEX GREEN",
                "code": "1000GY",
                "standard": "AS2683",
            },
            {
                "legacy_id": "57",
                "category": "Stainless Steel",
                "sub_category": "Convoluted",
                "name": "SS1 CONV",
                "code": "NA",
                "standard": "ISO103802012",
            },
        ],
    }


def generate_dirty_legacy_dataset() -> SyntheticDataset:
    dataset = generate_clean_dataset()
    dataset["customers"] = [
        {
            "legacy_id": "39733",
            "code": " vopa ",
            "name": "Vopak",
            "city": "Port Botany",
            "state": "NSW",
            "country": "AU",
            "email": "site.contact+vopa@example.invalid",
            "hms_retest": True,
            "retest_month": 6,
        },
        {
            "legacy_id": "43702",
            "code": "VOPA",
            "name": "Vopak Pty Ltd",
            "city": "Port Botany",
            "state": "NSW",
            "country": "AU",
            "email": "duplicate+vopa@example.invalid",
            "hms_retest": True,
            "retest_month": 6,
        },
        {
            "legacy_id": "BADNAME",
            "code": "BADNAME",
            "name": "",
            "city": "Unknown",
            "state": "NSW",
            "country": "AU",
            "email": "missing-name@example.invalid",
            "hms_retest": False,
            "retest_month": 0,
        },
        {
            "legacy_id": "43696",
            "code": "oric",
            "name": "Orica Mining Services",
            "city": "Kooragang",
            "state": "NSW",
            "country": "AU",
            "email": "maintenance+oric@example.invalid",
            "hms_retest": True,
            "retest_month": 6,
        },
        {
            "legacy_id": "NOCODE",
            "code": "",
            "name": "No Code Customer",
            "city": "Unknown",
            "state": "NSW",
            "country": "AU",
            "email": "missing-code@example.invalid",
            "hms_retest": True,
            "retest_month": 7,
        },
    ]
    return dataset


def write_dataset(dataset: SyntheticDataset, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(dataset, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
