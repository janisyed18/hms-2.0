#!/usr/bin/env python3
"""Reject a Terraform plan artifact that is not bound to the reviewed run."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--plan-run-id", required=True)
    parser.add_argument("--commit-sha", required=True)
    parser.add_argument("--terraform-version", required=True)
    args = parser.parse_args()

    directory = args.directory
    manifest_path = directory / "plan-manifest.json"
    lockfile_path = directory / ".terraform.lock.hcl"
    plan_path = directory / "tfplan.age"
    readable_plan_path = directory / "tfplan.txt.age"

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        expected = {
            "commit_sha": args.commit_sha,
            "plan_run_id": args.plan_run_id,
            "terraform_version": args.terraform_version,
            "lockfile_sha256": sha256(lockfile_path),
            "plan_ciphertext_sha256": sha256(plan_path),
            "readable_plan_ciphertext_sha256": sha256(readable_plan_path),
        }
    except (FileNotFoundError, json.JSONDecodeError) as error:
        print(f"Invalid Terraform plan artifact: {error}", file=sys.stderr)
        return 1

    mismatches = {
        key: {"expected": value, "actual": manifest.get(key)}
        for key, value in expected.items()
        if manifest.get(key) != value
    }
    if mismatches:
        print(json.dumps(mismatches, indent=2), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
