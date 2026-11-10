#!/usr/bin/env python3
"""PASS/FAIL assertions about the protected history storage in a Terraform plan.

Prints only fixed check names, a result and the basis of the result. It never prints
a plan value, a policy document, a variable or a container definition, so the output
is safe for a workflow summary. Values that Terraform only knows after apply (the new
bucket's name and ARN, and everything built from them) cannot be read from the plan;
those checks are answered from the Terraform source of the same, verified commit and
are labelled SOURCE. Anything that could not be established is UNVERIFIED, never PASS.

Exit status is 1 if any check FAILED.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

PASS, FAIL, UNVERIFIED = "PASS", "FAIL", "UNVERIFIED"

APP_EVIDENCE_ACTIONS = {
    "s3:PutObject",
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:GetObjectRetention",
}
APP_PROTECTION_READ_ACTIONS = {
    "s3:GetBucketVersioning",
    "s3:GetBucketObjectLockConfiguration",
}
DENIED_TO_APP_ROLE = {
    "s3:DeleteObject",
    "s3:DeleteObjectVersion",
    "s3:PutObjectRetention",
    "s3:PutObjectLegalHold",
    "s3:BypassGovernanceRetention",
    "s3:PutBucketObjectLockConfiguration",
    "s3:PutBucketVersioning",
    "s3:PutLifecycleConfiguration",
    "s3:PutBucketPolicy",
    "s3:DeleteBucketPolicy",
    "s3:DeleteBucket",
}
# Stateful resources that must never be deleted or replaced by this change.
STATEFUL_PREFIXES = (
    "aws_db_",
    "aws_s3_bucket",
    "aws_elasticache_",
    "aws_cloudfront_distribution",
    "aws_efs_",
    "aws_kms_",
    "aws_secretsmanager_",
)


class Checks:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def add(self, name: str, result: str, basis: str) -> None:
        self.rows.append((name, result, basis))

    def check(self, name: str, ok: bool | None, basis: str) -> None:
        self.add(name, UNVERIFIED if ok is None else PASS if ok else FAIL, basis)

    @property
    def failed(self) -> bool:
        return any(result == FAIL for _, result, _ in self.rows)


def _resource(plan: dict[str, Any], address: str) -> dict[str, Any] | None:
    for item in plan.get("resource_changes") or []:
        if item.get("address") == address:
            change: dict[str, Any] = item.get("change") or {}
            return change
    return None


def _first(value: Any) -> dict[str, Any]:
    return value[0] if isinstance(value, list) and value else {}


def _known(change: dict[str, Any], *path: str) -> bool:
    node: Any = change.get("after_unknown") or {}
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
        if node is None:
            return True
    return node is not True


def _block(source: str, header: str) -> str | None:
    """The text of the HCL block that starts with ``header``, braces matched."""
    start = source.find(header)
    if start == -1:
        return None
    depth, index = 0, source.index("{", start)
    for position in range(index, len(source)):
        depth += {"{": 1, "}": -1}.get(source[position], 0)
        if depth == 0:
            return source[start : position + 1]
    return None


def _action_lists(block: str) -> list[set[str]]:
    lists = []
    for match in re.finditer(r"Action\s*=\s*\[(.*?)\]", block, re.S):
        lists.append(set(re.findall(r'"([^"]+)"', match.group(1))))
    return lists


def check_bucket(plan: dict[str, Any], checks: Checks) -> None:
    bucket = _resource(plan, "aws_s3_bucket.history")
    after = (bucket or {}).get("after") or {}
    checks.check(
        "History bucket is created with Object Lock enabled",
        None if bucket is None else bucket.get("actions") == ["create"]
        and after.get("object_lock_enabled") is True,
        "plan",
    )
    config = _resource(plan, "aws_s3_bucket_object_lock_configuration.history")
    after = (config or {}).get("after") or {}
    retention = _first(_first(after.get("rule")).get("default_retention"))
    checks.check(
        "Object Lock configuration is enabled",
        None if config is None else after.get("object_lock_enabled") == "Enabled",
        "plan",
    )
    checks.check(
        "Default retention mode is GOVERNANCE",
        None if config is None else retention.get("mode") == "GOVERNANCE",
        "plan",
    )
    checks.check(
        "Default retention is exactly 30 days",
        None
        if config is None
        else retention.get("days") == 30 and not retention.get("years"),
        "plan",
    )
    encryption = _resource(
        plan, "aws_s3_bucket_server_side_encryption_configuration.history"
    )
    default = _first(
        _first(((encryption or {}).get("after") or {}).get("rule")).get(
            "apply_server_side_encryption_by_default"
        )
    )
    checks.check(
        "Encryption is SSE-S3 (AES256) with no KMS key",
        None
        if encryption is None
        else default.get("sse_algorithm") == "AES256"
        and not default.get("kms_master_key_id"),
        "plan",
    )
    block = _resource(plan, "aws_s3_bucket_public_access_block.history")
    after = (block or {}).get("after") or {}
    checks.check(
        "All four public-access protections are enabled",
        None
        if block is None
        else all(
            after.get(key) is True
            for key in (
                "block_public_acls",
                "block_public_policy",
                "ignore_public_acls",
                "restrict_public_buckets",
            )
        ),
        "plan",
    )
    versioning = _resource(plan, "aws_s3_bucket_versioning.history")
    status = _first(
        ((versioning or {}).get("after") or {}).get("versioning_configuration")
    )
    checks.check(
        "Versioning is enabled",
        None if versioning is None else status.get("status") == "Enabled",
        "plan",
    )


def check_variables(plan: dict[str, Any], checks: Checks) -> None:
    variables = plan.get("variables") or {}

    def value(name: str) -> Any:
        return (variables.get(name) or {}).get("value")

    checks.check(
        "Evidence retention approval is empty (deletion stays unavailable)",
        None if "history_retention_approval" not in variables
        else value("history_retention_approval") in ("", None),
        "plan variables",
    )
    checks.check(
        "Retention is configured as 30 days GOVERNANCE, not years",
        None
        if "history_retention_days" not in variables
        else value("history_retention_days") == 30
        and not value("history_retention_years")
        and value("history_retention_mode") == "GOVERNANCE",
        "plan variables",
    )


def check_source(directory: Path, checks: Checks) -> None:
    main = (directory / "main.tf").read_text(encoding="utf-8")
    policy = _block(main, 'resource "aws_iam_role_policy" "ecs_task_history"')
    lists = _action_lists(policy) if policy else []
    allowed = {frozenset(APP_EVIDENCE_ACTIONS), frozenset(APP_PROTECTION_READ_ACTIONS)}
    checks.check(
        "History IAM policy grants only evidence read/write and protection reads",
        None if policy is None else bool(lists) and {frozenset(a) for a in lists} == allowed
        and "Deny" not in policy,
        "SOURCE (policy contains values known only after apply)",
    )
    bucket_policy = _block(main, 'resource "aws_s3_bucket_policy" "history"')
    deny = [
        a
        for a in _action_lists(bucket_policy or "")
        if a != {"s3:*"}
    ]
    checks.check(
        "Bucket policy denies app-role deletion, retention changes and bypass",
        None if bucket_policy is None else deny == [DENIED_TO_APP_ROLE]
        and "aws_iam_role.ecs_task.arn" in bucket_policy
        and "aws:SecureTransport" in bucket_policy,
        "SOURCE (policy contains values known only after apply)",
    )
    enabled = re.search(r'name\s*=\s*"CUSTOMER_DELETION_ENABLED"\s*\n\s*value\s*=\s*(.+)', main)
    checks.check(
        "CUSTOMER_DELETION_ENABLED is absent or false",
        enabled is None or enabled.group(1).strip().strip('"').lower() == "false",
        "SOURCE (container definitions contain values known only after apply)",
    )
    approval = re.search(
        r'name\s*=\s*"HISTORY_RETENTION_APPROVAL"\s*\n\s*value\s*=\s*(.+)', main
    )
    checks.check(
        "HISTORY_RETENTION_APPROVAL comes only from the (empty) approval variable",
        approval is not None
        and approval.group(1).strip() == "var.history_retention_approval",
        "SOURCE (container definitions contain values known only after apply)",
    )


def check_blast_radius(plan: dict[str, Any], checks: Checks) -> None:
    risky: list[str] = []
    unexpected: list[str] = []
    for item in plan.get("resource_changes") or []:
        actions = (item.get("change") or {}).get("actions") or []
        if "delete" not in actions:
            continue
        rtype = str(item.get("type", ""))
        if rtype != "aws_ecs_task_definition":
            unexpected.append(rtype)
        if rtype.startswith(STATEFUL_PREFIXES):
            risky.append(rtype)
    checks.check(
        "No stateful resource (RDS, media buckets, CloudFront, KMS) is deleted or replaced",
        not risky,
        "plan",
    )
    checks.check(
        "Only ECS task definitions are replaced or destroyed",
        not unexpected,
        "plan",
    )
    touched = [
        str(item.get("address", ""))
        for item in plan.get("resource_changes") or []
        if (item.get("change") or {}).get("actions") not in (["no-op"], ["read"])
        and str(item.get("type", "")).startswith(("aws_db_", "aws_s3_bucket"))
        and ".history" not in str(item.get("address", ""))
    ]
    checks.check(
        "Existing RDS and media/inspector buckets are not changed at all",
        not touched,
        "plan",
    )


def render(checks: Checks) -> str:
    lines = [
        "## History storage assertions",
        "",
        "Fixed checks only; no plan value is printed. UNVERIFIED means it cannot be "
        "established from the plan and must be checked after apply.",
        "",
        "| Check | Result | Basis |",
        "|---|---|---|",
    ]
    lines += [f"| {name} | **{result}** | {basis} |" for name, result, basis in checks.rows]
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan-json", type=Path, required=True)
    parser.add_argument("--terraform-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan_json.read_text(encoding="utf-8"))
        checks = Checks()
        check_bucket(plan, checks)
        check_variables(plan, checks)
        check_source(args.terraform_dir, checks)
        check_blast_radius(plan, checks)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Could not evaluate the plan: {type(error).__name__}", file=sys.stderr)
        return 1
    sys.stdout.write(render(checks))
    return 1 if checks.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
