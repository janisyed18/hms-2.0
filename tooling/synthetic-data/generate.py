from __future__ import annotations

import argparse
from pathlib import Path

from hms_backend.app.tooling.synthetic import (
    generate_clean_dataset,
    generate_dirty_legacy_dataset,
    write_dataset,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate HMS synthetic data.")
    parser.add_argument(
        "--kind",
        choices=["clean", "dirty"],
        default="clean",
        help="Fixture style to generate.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output JSON path.",
    )
    args = parser.parse_args()

    dataset = (
        generate_clean_dataset()
        if args.kind == "clean"
        else generate_dirty_legacy_dataset()
    )
    write_dataset(dataset, args.output)


if __name__ == "__main__":
    main()
