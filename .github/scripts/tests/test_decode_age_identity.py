from __future__ import annotations

import base64
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DECODER = REPOSITORY_ROOT / ".github/scripts/decode-age-identity.py"
IDENTITY = b"# created: test\n# public key: age1test\nAGE-SECRET-KEY-1TEST\n"


class DecodeAgeIdentityTests(unittest.TestCase):
    def decode(
        self, directory: Path, payload: bytes
    ) -> tuple[subprocess.CompletedProcess[bytes], Path]:
        output = directory / "age.key"
        result = subprocess.run(
            [sys.executable, str(DECODER), "--output", str(output)],
            input=payload,
            capture_output=True,
            check=False,
        )
        return result, output

    def test_decodes_base64_age_identity_with_owner_only_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            result, output = self.decode(
                Path(temporary_directory), base64.b64encode(IDENTITY)
            )

            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(output.read_bytes(), IDENTITY)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_rejects_non_base64_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            result, output = self.decode(
                Path(temporary_directory), b"AGE-SECRET-KEY-1RAW"
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"base64", result.stderr)
            self.assertFalse(output.exists())

    def test_rejects_base64_payload_without_age_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            result, output = self.decode(
                Path(temporary_directory), base64.b64encode(b"not an identity")
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"not an age identity", result.stderr)
            self.assertFalse(output.exists())
