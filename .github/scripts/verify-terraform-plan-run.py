#!/usr/bin/env python3
"""Reject a plan run that is not a successful Plan for the current main commit."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

EXPECTED_WORKFLOW = "Plan AWS Dev Infrastructure"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-json", type=Path, required=True)
    parser.add_argument("--commit-sha", required=True)
    args = parser.parse_args()

    try:
        run = json.loads(args.run_json.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as error:
        print(f"Invalid plan run response: {error}", file=sys.stderr)
        return 1

    expected = {
        "name": EXPECTED_WORKFLOW,
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
        "head_sha": args.commit_sha,
    }
    mismatches = {
        key: {"expected": value, "actual": run.get(key)}
        for key, value in expected.items()
        if run.get(key) != value
    }
    if mismatches:
        print(json.dumps(mismatches, indent=2), file=sys.stderr)
        print(
            "The supplied plan run is not a successful plan for the current main commit.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
