import json
from pathlib import Path

from hms_backend.app.tooling.synthetic import (
    generate_clean_dataset,
    generate_dirty_legacy_dataset,
    write_dataset,
)


def test_clean_dataset_contains_legacy_shaped_demo_records() -> None:
    dataset = generate_clean_dataset()

    customer_codes = [customer["code"] for customer in dataset["customers"]]

    assert dataset["schema_version"] == "hms.synthetic.v1"
    assert customer_codes == ["VOPA", "ORIC", "LINFOX"]
    assert len(customer_codes) == len(set(customer_codes))
    assert dataset["customers"][0]["legacy_id"] == "39733"
    assert dataset["assets"][0]["customer_code"] == "VOPA"
    assert dataset["assets"][0]["asset_id"] == "997950"
    assert dataset["products"][0]["category"] == "Composite"


def test_dirty_dataset_includes_known_validation_failures() -> None:
    dataset = generate_dirty_legacy_dataset()

    customer_codes = [
        customer.get("code", "").strip().upper()
        for customer in dataset["customers"]
    ]
    customer_names = [customer.get("name", "") for customer in dataset["customers"]]

    assert customer_codes.count("VOPA") == 2
    assert "" in customer_names
    assert dataset["customers"][0]["code"] == " vopa "


def test_write_dataset_outputs_stable_pretty_json(tmp_path: Path) -> None:
    output_path = tmp_path / "clean.json"
    dataset = generate_clean_dataset()

    write_dataset(dataset, output_path)

    written = output_path.read_text(encoding="utf-8")
    loaded = json.loads(written)
    assert loaded == dataset
    assert written.endswith("\n")
    assert '\n  "customers": [' in written
