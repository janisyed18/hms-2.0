from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
VERIFIER = REPOSITORY_ROOT / ".github/scripts/verify-terraform-plan-artifact.py"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TerraformPlanArtifactVerifierTests(unittest.TestCase):
    def create_artifact(self, directory: Path) -> None:
        lockfile = directory / ".terraform.lock.hcl"
        plan = directory / "tfplan.age"
        readable_plan = directory / "tfplan.txt.age"
        lockfile.write_text('provider "aws" {}\n', encoding="utf-8")
        plan.write_bytes(b"encrypted-plan")
        readable_plan.write_bytes(b"encrypted-readable-plan")
        (directory / "plan-manifest.json").write_text(
            json.dumps(
                {
                    "commit_sha": "reviewed-commit",
                    "plan_run_id": "12345",
                    "terraform_version": "1.15.8",
                    "lockfile_sha256": sha256(lockfile),
                    "plan_ciphertext_sha256": sha256(plan),
                    "readable_plan_ciphertext_sha256": sha256(readable_plan),
                }
            ),
            encoding="utf-8",
        )

    def verify(self, directory: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(VERIFIER),
                "--directory",
                str(directory),
                "--plan-run-id",
                "12345",
                "--commit-sha",
                "reviewed-commit",
                "--terraform-version",
                "1.15.8",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_accepts_artifact_bound_to_reviewed_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            self.create_artifact(directory)
            self.assertEqual(self.verify(directory).returncode, 0)

    def test_rejects_tampered_ciphertext_before_apply(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            self.create_artifact(directory)
            (directory / "tfplan.age").write_bytes(b"tampered-ciphertext")

            result = self.verify(directory)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("plan_ciphertext_sha256", result.stderr)


if __name__ == "__main__":
    unittest.main()
