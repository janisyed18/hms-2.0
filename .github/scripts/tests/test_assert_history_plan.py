from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / ".github/scripts/assert-history-plan.py"
TERRAFORM_DIR = ROOT / "infra/terraform/envs/dev"
CANARY = "CANARY-SECRET-VALUE-4e19"


def change(address, rtype, actions, after=None):
    return {
        "address": address,
        "type": rtype,
        "change": {"actions": actions, "before": None, "after": after or {}},
    }


GOOD = {
    "variables": {
        "history_retention_days": {"value": 30},
        "history_retention_years": {"value": 0},
        "history_retention_mode": {"value": "GOVERNANCE"},
        "history_retention_approval": {"value": ""},
        "customer_deletion_enabled": {"value": False},
        "db_password": {"value": CANARY},
    },
    "resource_changes": [
        change("aws_s3_bucket.history", "aws_s3_bucket", ["create"],
               {"object_lock_enabled": True}),
        change("aws_s3_bucket_versioning.history", "aws_s3_bucket_versioning",
               ["create"], {"versioning_configuration": [{"status": "Enabled"}]}),
        change("aws_s3_bucket_object_lock_configuration.history",
               "aws_s3_bucket_object_lock_configuration", ["create"],
               {"object_lock_enabled": "Enabled", "rule": [{"default_retention": [
                   {"mode": "GOVERNANCE", "days": 30, "years": None}]}]}),
        change("aws_s3_bucket_server_side_encryption_configuration.history",
               "aws_s3_bucket_server_side_encryption_configuration", ["create"],
               {"rule": [{"apply_server_side_encryption_by_default": [
                   {"sse_algorithm": "AES256", "kms_master_key_id": None}]}]}),
        change("aws_s3_bucket_public_access_block.history",
               "aws_s3_bucket_public_access_block", ["create"],
               {"block_public_acls": True, "block_public_policy": True,
                "ignore_public_acls": True, "restrict_public_buckets": True}),
        change("aws_ecs_task_definition.api", "aws_ecs_task_definition",
               ["create", "delete"]),
        change("aws_db_instance.postgres", "aws_db_instance", ["no-op"]),
    ],
}


def run(plan, terraform_dir=TERRAFORM_DIR):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "plan.json"
        path.write_text(json.dumps(plan), encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--plan-json", str(path),
             "--terraform-dir", str(terraform_dir)],
            capture_output=True, text=True, check=False,
        )


class AssertHistoryPlanTests(unittest.TestCase):
    def test_the_expected_plan_passes_every_check_and_leaks_nothing(self) -> None:
        result = run(GOOD)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("FAIL", result.stdout)
        self.assertNotIn("UNVERIFIED", result.stdout.split("|---|---|---|")[1])
        self.assertNotIn(CANARY, result.stdout + result.stderr)
        self.assertNotIn("30 days\"", result.stdout)

    def mutated(self, edit):
        plan = copy.deepcopy(GOOD)
        edit(plan)
        return run(plan)

    def test_each_wrong_setting_fails(self) -> None:
        cases = {
            "mode": lambda p: p["resource_changes"][2]["change"]["after"]["rule"][0][
                "default_retention"][0].update(mode="COMPLIANCE"),
            "days": lambda p: p["resource_changes"][2]["change"]["after"]["rule"][0][
                "default_retention"][0].update(days=7),
            "kms": lambda p: p["resource_changes"][3]["change"]["after"]["rule"][0][
                "apply_server_side_encryption_by_default"][0].update(
                    sse_algorithm="aws:kms"),
            "public": lambda p: p["resource_changes"][4]["change"]["after"].update(
                block_public_acls=False),
            "approval": lambda p: p["variables"]["history_retention_approval"].update(
                value="DEC-1"),
            "enabled_without_approval": lambda p: p["variables"][
                "customer_deletion_enabled"].update(value=True),
            "versioning": lambda p: p["resource_changes"][1]["change"]["after"][
                "versioning_configuration"][0].update(status="Suspended"),
        }
        for name, edit in cases.items():
            with self.subTest(name):
                result = self.mutated(edit)
                self.assertEqual(result.returncode, 1)
                self.assertIn("FAIL", result.stdout)
                self.assertNotIn(CANARY, result.stdout)

    def test_replacing_stateful_resources_fails(self) -> None:
        result = self.mutated(
            lambda p: p["resource_changes"].append(
                change("aws_db_instance.postgres", "aws_db_instance",
                       ["delete", "create"])
            )
        )
        self.assertEqual(result.returncode, 1)

    def test_destroy_before_create_task_definitions_fail(self) -> None:
        result = self.mutated(
            lambda p: p["resource_changes"][5]["change"].update(
                actions=["delete", "create"]
            )
        )
        self.assertEqual(result.returncode, 1)
        self.assertTrue(
            any("create-before-destroy" in l and "**FAIL**" in l
                for l in result.stdout.splitlines())
        )

    def test_changing_the_media_bucket_fails(self) -> None:
        result = self.mutated(
            lambda p: p["resource_changes"].append(
                change("aws_s3_bucket.media", "aws_s3_bucket", ["update"])
            )
        )
        self.assertEqual(result.returncode, 1)

    def test_missing_resources_are_unverified_not_passed(self) -> None:
        result = run({"resource_changes": [], "variables": {}})
        self.assertIn("UNVERIFIED", result.stdout)
        self.assertNotIn("**PASS** | plan", result.stdout.split("Fixed checks")[1].split(
            "UNVERIFIED means")[0])

    def test_deletion_on_with_the_recorded_approval_reference_passes(self) -> None:
        reference = (
            "https://github.com/janisyed18/hms-2.0/issues/125#issuecomment-6787691378"
        )

        def enable(plan: dict) -> None:
            plan["variables"]["customer_deletion_enabled"]["value"] = True
            plan["variables"]["history_retention_approval"]["value"] = reference

        result = self.mutated(enable)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("**FAIL**", result.stdout)

    def test_source_checks_fail_when_the_source_drifts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = (TERRAFORM_DIR / "main.tf").read_text(encoding="utf-8")
            broken = source.replace('"s3:DeleteObjectVersion",', "", 1).replace(
                'name  = "HISTORY_RETENTION_APPROVAL"\n      value = var.history_retention_approval',
                'name  = "HISTORY_RETENTION_APPROVAL"\n      value = "approved"',
            )
            self.assertNotEqual(source, broken)
            (Path(tmp) / "main.tf").write_text(broken, encoding="utf-8")
            result = run(GOOD, Path(tmp))
        self.assertEqual(result.returncode, 1)
        self.assertGreaterEqual(result.stdout.count("**FAIL**"), 2)

    def test_it_never_prints_a_variable_value(self) -> None:
        plan = copy.deepcopy(GOOD)
        plan["variables"]["history_retention_approval"]["value"] = CANARY
        result = run(plan)
        self.assertNotIn(CANARY, result.stdout + result.stderr)


IAM = 'resource "aws_iam_role_policy" "ecs_task_history"'
BUCKET_POLICY = 'resource "aws_s3_bucket_policy" "history"'


def mutate_block(source: str, header: str, old: str, new: str) -> str:
    """Replace ``old`` with ``new`` only inside the block that starts at ``header``."""
    start = source.index(header)
    end = source.index("\nresource ", start + 1)
    block = source[start:end]
    assert old in block, old
    return source[:start] + block.replace(old, new, 1) + source[end:]


class PolicyMutationTests(unittest.TestCase):
    def failing(self, header: str, old: str, new: str, check: str) -> None:
        source = (TERRAFORM_DIR / "main.tf").read_text(encoding="utf-8")
        mutated = mutate_block(source, header, old, new)
        self.assertNotEqual(source, mutated)
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "main.tf").write_text(mutated, encoding="utf-8")
            result = run(GOOD, Path(tmp))
        self.assertEqual(result.returncode, 1, old)
        failed = [
            line for line in result.stdout.splitlines() if "**FAIL**" in line
        ]
        self.assertTrue(any(check in line for line in failed), failed)
        self.assertNotIn(CANARY, result.stdout)

    def test_the_real_source_passes(self) -> None:
        result = run(GOOD)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_bucket_policy_mutations_fail(self) -> None:
        check = "Bucket policy denies"
        cases = {
            "effect becomes Allow": ('Effect    = "Deny"\n        Principal = { AWS',
                                     'Effect    = "Allow"\n        Principal = { AWS'),
            "principal becomes everyone": ("Principal = { AWS = aws_iam_role.ecs_task.arn }",
                                           'Principal = "*"'),
            "principal becomes another role": ("aws_iam_role.ecs_task.arn }",
                                               "aws_iam_role.ecs_exec.arn }"),
            "a denied action is dropped": ('"s3:BypassGovernanceRetention",', ""),
            "an extra action is denied": ('"s3:DeleteBucket",', '"s3:DeleteBucket",\n          "s3:GetObject",'),
            "scope narrows to the bucket only": ('"${aws_s3_bucket.history.arn}/*",\n        ]\n      },\n    ]',
                                                 "]\n      },\n    ]"),
            "NotAction replaces Action": ("        Action = [\n          \"s3:DeleteObject\"",
                                          "        NotAction = [\n          \"s3:DeleteObject\""),
            "an extra conjunctive condition": (
                'Bool = { "aws:SecureTransport" = "false" }',
                'Bool = { "aws:SecureTransport" = "false" }\n'
                '          StringEquals = { "aws:PrincipalTag/env" = "never" }',
            ),
            "an extra key in the same operator": (
                'Bool = { "aws:SecureTransport" = "false" }',
                'Bool = { "aws:SecureTransport" = "false", "aws:ViaAWSService" = "true" }',
            ),
            "the TLS condition is inverted": ('Bool = { "aws:SecureTransport" = "false" }',
                                             'Bool = { "aws:SecureTransport" = "true" }'),
        }
        for name, (old, new) in cases.items():
            with self.subTest(name):
                self.failing(BUCKET_POLICY, old, new, check)

    def test_history_iam_policy_mutations_fail(self) -> None:
        check = "History IAM policy"
        cases = {
            "an extra allowed action": ('"s3:GetObjectRetention",', '"s3:GetObjectRetention",\n          "s3:DeleteObject",'),
            "a missing action": ('"s3:GetObjectVersion",', ""),
            "wildcard resource": ('Resource = "${aws_s3_bucket.history.arn}/*"', 'Resource = "*"'),
            "effect becomes Deny": ('Effect = "Allow"\n        Action = [\n          "s3:PutObject"',
                                    'Effect = "Deny"\n        Action = [\n          "s3:PutObject"'),
            "an extra statement": ("    Statement = [\n",
                                   '    Statement = [\n      {\n        Effect = "Allow"\n'
                                   '        Action = ["s3:*"]\n        Resource = "*"\n      },\n'),
            "attached to another role": ("role = aws_iam_role.ecs_task.id", "role = aws_iam_role.ecs_exec.id"),
            "a Condition is added": ('Resource = aws_s3_bucket.history.arn',
                                     'Resource = aws_s3_bucket.history.arn\n        Condition = {}'),
        }
        for name, (old, new) in cases.items():
            with self.subTest(name):
                self.failing(IAM, old, new, check)


if __name__ == "__main__":
    unittest.main()
