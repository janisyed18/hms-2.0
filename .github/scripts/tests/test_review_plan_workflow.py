#!/usr/bin/env python3
"""Guard the release controls of the review-only Terraform plan workflow."""

from __future__ import annotations

import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / "workflows"
    / "review-aws-dev-infrastructure-plan.yml"
).read_text(encoding="utf-8")


def step(name: str) -> str:
    start = WORKFLOW.index(f"- name: {name}")
    nxt = WORKFLOW.find("\n      - ", start + 1)
    return WORKFLOW[start : nxt if nxt != -1 else len(WORKFLOW)]


class ReviewPlanWorkflowTests(unittest.TestCase):
    def test_it_never_applies_or_holds_aws_credentials(self) -> None:
        for forbidden in (
            "terraform apply",
            "configure-aws-credentials",
            "id-token",
            "role-to-assume",
            "TERRAFORM_ROLE_ARN",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, WORKFLOW)

    def test_it_runs_only_in_the_protected_environment_from_main(self) -> None:
        self.assertIn("environment: aws-dev", WORKFLOW)
        self.assertIn('test "$GITHUB_REF" = "refs/heads/main"', WORKFLOW)
        self.assertIn("ref: main", WORKFLOW)

    def test_decryption_key_is_confined_to_the_decrypt_step(self) -> None:
        self.assertEqual(WORKFLOW.count("AWS_DEV_TERRAFORM_PLAN_AGE_PRIVATE_KEY"), 2)
        decrypt = step("Decrypt the reviewed plan")
        self.assertIn("secrets.AWS_DEV_TERRAFORM_PLAN_AGE_PRIVATE_KEY", decrypt)
        self.assertNotIn(
            "secrets.", WORKFLOW.replace(decrypt, "")
            .replace("secrets.GITHUB_TOKEN", "")
        )

    def test_report_step_has_no_secret_and_discards_the_plaintext(self) -> None:
        publish = step("Publish sanitized structural report")
        self.assertNotIn("secrets.", publish)
        self.assertIn("terraform show -json tfplan > plan.json 2>/dev/null", publish)
        self.assertIn('shred --remove --zero --iterations=1 tfplan plan.json', publish)
        self.assertIn('>> "$GITHUB_STEP_SUMMARY"', publish)
        # The raw plan is never written to the log.
        self.assertNotIn("terraform show -no-color", WORKFLOW)

    def test_only_the_sanitized_report_is_ever_uploaded(self) -> None:
        # Exactly one upload step, and it carries exactly one file: the summarizer's
        # output. Anything derived from the plan itself must never be uploaded.
        self.assertEqual(WORKFLOW.count("upload-artifact"), 1)
        upload = step("Upload sanitized structural report")
        self.assertIn(
            "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", upload
        )
        self.assertIn(
            "path: ${{ runner.temp }}/structural-report/structural-report.md", upload
        )
        self.assertEqual(upload.count("path:"), 1)
        self.assertIn("retention-days: 1", upload)
        self.assertIn("if-no-files-found: error", upload)
        self.assertNotIn("secrets.", upload)
        for raw in (
            "tfplan",
            "plan.json",
            ".age",
            "plan-manifest",
            "terraform show",
            "infra/terraform",
            "*",
        ):
            with self.subTest(raw=raw):
                self.assertNotIn(raw, upload.split("with:", 1)[1])

    def test_report_is_written_outside_the_terraform_directory_and_kept(self) -> None:
        publish = step("Publish sanitized structural report")
        self.assertIn('report="$report_dir/structural-report.md"', publish)
        self.assertIn('report_dir="$RUNNER_TEMP/structural-report"', publish)
        # Raw plan material is shredded; the report is deliberately not.
        cleanup = publish[publish.index("cleanup()") : publish.index("trap cleanup")]
        self.assertIn("tfplan plan.json", cleanup)
        self.assertNotIn("report", cleanup)
        self.assertNotIn("$GITHUB_STEP_SUMMARY\n", cleanup)
        self.assertLess(
            WORKFLOW.index("Publish sanitized structural report"),
            WORKFLOW.index("Upload sanitized structural report"),
        )

    def test_plan_source_and_integrity_are_verified_before_decryption(self) -> None:
        self.assertLess(
            WORKFLOW.index("verify-terraform-plan-run.py"),
            WORKFLOW.index("Decrypt the reviewed plan"),
        )
        self.assertLess(
            WORKFLOW.index("verify-terraform-plan-artifact.py"),
            WORKFLOW.index("Decrypt the reviewed plan"),
        )
        self.assertIn("digest-mismatch: error", WORKFLOW)

    def test_terraform_init_does_not_need_the_remote_backend(self) -> None:
        self.assertIn(
            "terraform init -backend=false -input=false -lockfile=readonly", WORKFLOW
        )


if __name__ == "__main__":
    unittest.main()
