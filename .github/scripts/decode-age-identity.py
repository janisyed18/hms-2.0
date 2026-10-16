#!/usr/bin/env python3
"""Decode a base64-encoded age identity without writing it to workflow logs."""

from __future__ import annotations

import argparse
import base64
import binascii
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    encoded_identity = sys.stdin.buffer.read().strip()
    try:
        identity = base64.b64decode(encoded_identity, validate=True)
    except binascii.Error:
        print("The age identity must be base64-encoded.", file=sys.stderr)
        return 1

    if not any(line.startswith(b"AGE-SECRET-KEY-") for line in identity.splitlines()):
        print("The decoded value is not an age identity.", file=sys.stderr)
        return 1

    file_descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(file_descriptor, "wb") as output:
        output.write(identity)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
