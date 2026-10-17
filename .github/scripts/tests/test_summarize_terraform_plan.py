from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SUMMARIZER = REPOSITORY_ROOT / ".github/scripts/summarize-terraform-plan.py"
RUN_VERIFIER = REPOSITORY_ROOT / ".github/scripts/verify-terraform-plan-run.py"

# Values that must never appear in a published report.
CANARIES = [
    "CANARY-DB-PASSWORD-9f31",
    "CANARY-PRIVATE-KEY-7c20",
    "CANARY-VARIABLE-VALUE-1d88",
    "CANARY-PRIOR-STATE-5b02",
    "CANARY-OUTPUT-VALUE-3a77",
]


def resource(address, rtype, actions, before=None, after=None, unknown=None, **extra):
    return {
        "address": address,
        "type": rtype,
        "change": {
            "actions": actions,
            "before": before,
            "after": after,
            "after_unknown": unknown or {},
            **extra,
        },
    }


PLAN = {
    "terraform_version": "1.15.8",
    "applyable": True,
    "errored": False,
    "variables": {"db_password": {"value": CANARIES[2]}},
    "prior_state": {"values": {"root": {"secret": CANARIES[3]}}},
    "resource_changes": [
        resource(
            "aws_secretsmanager_secret.pki_signer",
            "aws_secretsmanager_secret",
            ["create"],
            None,
            {"name": "hms-dev-pki-signer", "secret_string": CANARIES[1]},
        ),
        resource(
            "aws_db_instance.postgres",
            "aws_db_instance",
            ["no-op"],
            {"password": CANARIES[0]},
            {"password": CANARIES[0]},
        ),
        resource(
            "aws_iam_role_policy.exec",
            "aws_iam_role_policy",
            ["update"],
            {"policy": '{"old": "CANARY-DB-PASSWORD-9f31"}', "name": "n"},
            {"policy": '{"new": "CANARY-PRIVATE-KEY-7c20"}', "name": "n"},
        ),
        resource(
            "aws_ecs_task_definition.engine",
            "aws_ecs_task_definition",
            ["delete", "create"],
            {"container_definitions": CANARIES[0], "family": "f"},
            {"container_definitions": CANARIES[1], "family": "f"},
            {"arn": True},
            replace_paths=[["container_definitions"]],
        ),
        resource(
            'aws_s3_bucket.logs["a|b"]',
            "aws_s3_bucket",
            ["delete"],
            {"bucket": "x"},
            None,
        ),
        resource(
            "data.aws_caller_identity.current",
            "aws_caller_identity",
            ["read"],
            None,
            {},
        ),
    ],
    "resource_drift": [
        resource(
            "aws_db_instance.postgres",
            "aws_db_instance",
            ["update"],
            {"latest_restorable_time": "t1", "password": CANARIES[0]},
            {"latest_restorable_time": "t2", "password": CANARIES[0]},
        )
    ],
    "output_changes": {
        "pki_secret_ids": {"actions": ["create"], "after": CANARIES[4]},
        "unchanged": {"actions": ["no-op"], "after": CANARIES[4]},
    },
}


def run_summarizer(plan: dict, manifest: dict | None = None) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as directory:
        plan_path = Path(directory) / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        command = [sys.executable, str(SUMMARIZER), "--plan-json", str(plan_path)]
        if manifest is not None:
            manifest_path = Path(directory) / "plan-manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            command += ["--manifest", str(manifest_path)]
        return subprocess.run(command, capture_output=True, text=True, check=False)


class SummarizeTerraformPlanTests(unittest.TestCase):
    def test_report_has_structure_and_no_values(self) -> None:
        result = run_summarizer(PLAN, {"plan_run_id": "123", "commit_sha": "abc"})
        self.assertEqual(result.returncode, 0, result.stderr)
        report = result.stdout
        for canary in CANARIES:
            self.assertNotIn(canary, report)
            self.assertNotIn(canary, result.stderr)
        self.assertIn("aws_secretsmanager_secret.pki_signer", report)
        self.assertIn("Plan run: `123`", report)

    def test_counts_match_terraform_plan_line(self) -> None:
        report = run_summarizer(PLAN).stdout
        # create + replace = 2 adds, 1 update, delete + replace = 2 destroys.
        self.assertIn("Plan: 2 to add, 1 to change, 2 to destroy.", report)

    def test_replacement_and_deletion_are_called_out_with_reason(self) -> None:
        report = run_summarizer(PLAN).stdout
        section = report.split("## Deletions and replacements")[1].split("##")[0]
        self.assertIn("**REPLACE** `aws_ecs_task_definition.engine`", section)
        self.assertIn("container_definitions", section)
        self.assertIn("**DELETE**", section)

    def test_update_lists_only_changed_attribute_names(self) -> None:
        report = run_summarizer(PLAN).stdout
        row = next(
            line
            for line in report.splitlines()
            if line.startswith("|") and "aws_iam_role_policy.exec" in line
        )
        attributes = row.split("|")[3].strip()
        self.assertEqual(attributes, "policy")

    def test_noop_and_read_are_not_reported_as_changes(self) -> None:
        report = run_summarizer(PLAN).stdout
        changes = report.split("## All changes")[1].split("## Drift")[0]
        self.assertNotIn("aws_db_instance.postgres", changes)
        self.assertNotIn("data.aws_caller_identity", changes)

    def test_iam_and_secret_resources_are_listed_separately(self) -> None:
        report = run_summarizer(PLAN).stdout
        section = report.split("## IAM, secret and KMS resources")[1].split("##")[0]
        self.assertIn("create `aws_secretsmanager_secret.pki_signer`", section)
        self.assertIn("update `aws_iam_role_policy.exec`", section)

    def test_drift_and_outputs_report_names_only(self) -> None:
        report = run_summarizer(PLAN).stdout
        self.assertIn(
            "update `aws_db_instance.postgres`: latest_restorable_time", report
        )
        self.assertIn("create `pki_secret_ids`", report)
        self.assertNotIn("`unchanged`", report)

    def test_address_cannot_break_the_markdown_table_or_smuggle_data(self) -> None:
        report = run_summarizer(PLAN).stdout
        self.assertIn('aws_s3_bucket.logs["a?b"]', report)
        self.assertNotIn("a|b", report)

    def test_clean_plan_reports_nothing_to_do(self) -> None:
        report = run_summarizer({"terraform_version": "1.15.8"}).stdout
        self.assertIn("Plan: 0 to add, 0 to change, 0 to destroy.", report)

    def test_unreadable_input_fails_without_echoing_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            path.write_text("{ not json " + CANARIES[0], encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SUMMARIZER), "--plan-json", str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(CANARIES[0], result.stdout + result.stderr)


class VerifyTerraformPlanRunTests(unittest.TestCase):
    RUN = {
        "name": "Plan AWS Dev Infrastructure",
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
        "head_sha": "abc",
    }

    def verify(self, run: dict, sha: str = "abc") -> int:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            path.write_text(json.dumps(run), encoding="utf-8")
            return subprocess.run(
                [
                    sys.executable,
                    str(RUN_VERIFIER),
                    "--run-json",
                    str(path),
                    "--commit-sha",
                    sha,
                ],
                capture_output=True,
                text=True,
                check=False,
            ).returncode

    def test_accepts_successful_plan_for_current_main(self) -> None:
        self.assertEqual(self.verify(self.RUN), 0)

    def test_rejects_every_deviation(self) -> None:
        for key, value in {
            "name": "Apply AWS Dev Infrastructure",
            "event": "push",
            "status": "in_progress",
            "conclusion": "failure",
            "head_branch": "feature",
            "head_sha": "other",
        }.items():
            with self.subTest(key=key):
                self.assertEqual(self.verify({**self.RUN, key: value}), 1)

    def test_rejects_plan_for_an_older_main_commit(self) -> None:
        self.assertEqual(self.verify(self.RUN, sha="newer-main"), 1)


if __name__ == "__main__":
    unittest.main()
