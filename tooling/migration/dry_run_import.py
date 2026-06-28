from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import cast

from hms_backend.app.tooling.migration import dry_run_import
from hms_backend.app.tooling.types import SyntheticDataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Dry-run HMS legacy import.")
    parser.add_argument("input", type=Path, help="Input synthetic/legacy JSON path.")
    args = parser.parse_args()

    dataset = cast(
        SyntheticDataset,
        json.loads(args.input.read_text(encoding="utf-8")),
    )
    report = dry_run_import(dataset)
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
