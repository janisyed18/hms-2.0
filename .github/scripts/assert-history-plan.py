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

# Recorded in docs/design/customer-deletion-approvals.md (DEV only, 2026-11-11).
APPROVED_DEV_REFERENCE = (
    "https://github.com/janisyed18/hms-2.0/issues/125#issuecomment-6787691378"
)

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
        "History bucket has Object Lock enabled and is new or unchanged",
        # An existing protected bucket plans as no-op; any update, replacement or
        # deletion of the evidence bucket must still fail the review.
        None
        if bucket is None
        else bucket.get("actions") in (["create"], ["no-op"])
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

    approval_value = value("history_retention_approval")
    checks.check(
        "Evidence retention approval is empty or the recorded DEV approval reference",
        None if "history_retention_approval" not in variables
        else approval_value in ("", None, APPROVED_DEV_REFERENCE),
        "plan variables",
    )
    checks.check(
        "Customer deletion is off, or on only with the recorded approval reference",
        None if "customer_deletion_enabled" not in variables
        else value("customer_deletion_enabled") in (False, None)
        or approval_value == APPROVED_DEV_REFERENCE,
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


def _strip_comments(text: str) -> str:
    return re.sub(r"(?m)^\s*(#|//).*$", "", text)


def _statements(block: str) -> list[dict[str, str]] | None:
    """Each ``Statement`` object as {top-level key: whitespace-free value text}.

    Returns None when the structure is not the simple shape we can reason about, so
    the check fails closed instead of guessing.
    """
    text = _strip_comments(block)
    head = re.search(r"Statement\s*=\s*\[", text)
    if head is None:
        return None
    statements: list[dict[str, str]] = []
    depth, start = 0, -1
    for position in range(head.end(), len(text)):
        char = text[position]
        if char == "{":
            if depth == 0:
                start = position + 1
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                statements.append(_fields(text[start:position]))
            if depth < 0:
                return None
        elif char == "]" and depth == 0:
            return statements
    return None


def _fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    depth, key, buffer = 0, None, []
    for line in body.splitlines():
        match = re.match(r"\s*(\w+)\s*=(.*)$", line) if depth == 0 else None
        if match:
            if key is not None:
                fields[key] = "".join(buffer)
            key, buffer = match.group(1), [match.group(2)]
        elif key is not None:
            buffer.append(line)
        depth += sum(line.count(c) for c in "{[(") - sum(line.count(c) for c in "}])")
    if key is not None:
        fields[key] = "".join(buffer)
    return {name: re.sub(r"\s+", "", value) for name, value in fields.items()}


def _actions(value: str) -> set[str]:
    return set(re.findall(r'"([^"]+)"', value))


BUCKET = "aws_s3_bucket.history.arn"
OBJECTS = '"${aws_s3_bucket.history.arn}/*"'


def _policy_is_exact(
    statements: list[dict[str, str]] | None, expected: list[dict[str, Any]]
) -> bool:
    """Exactly the expected statements: no extra statement, key, action or scope."""
    if statements is None or len(statements) != len(expected):
        return False
    remaining = list(statements)
    for want in expected:
        match = next(
            (
                got
                for got in remaining
                if set(got) == set(want["keys"])
                and got.get("Effect") == f'"{want["effect"]}"'
                and got.get("Principal") == want.get("principal", got.get("Principal"))
                and _actions(got.get("Action", "")) == want["actions"]
                and sorted(t for t in got["Resource"].strip("[]").split(",") if t)
                == sorted(want["resources"])
                and got.get("Condition", "") == want.get("condition", "")
            ),
            None,
        )
        if match is None:
            return False
        remaining.remove(match)
    return True


def check_source(directory: Path, checks: Checks) -> None:
    main = (directory / "main.tf").read_text(encoding="utf-8")
    policy = _block(main, 'resource "aws_iam_role_policy" "ecs_task_history"')
    allow_keys = ["Effect", "Action", "Resource"]
    checks.check(
        "History IAM policy grants only evidence read/write and protection reads",
        None
        if policy is None
        else "role=aws_iam_role.ecs_task.id" in re.sub(r"\s+", "", policy)
        and _policy_is_exact(
            _statements(policy),
            [
                {
                    "keys": allow_keys,
                    "effect": "Allow",
                    "actions": APP_EVIDENCE_ACTIONS,
                    "resources": [OBJECTS],
                },
                {
                    "keys": allow_keys,
                    "effect": "Allow",
                    "actions": APP_PROTECTION_READ_ACTIONS,
                    "resources": [BUCKET],
                },
            ],
        ),
        "SOURCE (policy contains values known only after apply)",
    )
    bucket_policy = _block(main, 'resource "aws_s3_bucket_policy" "history"')
    both = [BUCKET, OBJECTS]
    checks.check(
        "Bucket policy denies app-role deletion, retention changes and bypass",
        None
        if bucket_policy is None
        else _policy_is_exact(
            _statements(bucket_policy),
            [
                {
                    "keys": ["Sid", "Effect", "Principal", "Action", "Resource", "Condition"],
                    "effect": "Deny",
                    "principal": '"*"',
                    "actions": {"s3:*"},
                    "resources": both,
                    # Exact, whitespace-free: no extra operator, key or value.
                    "condition": '{Bool={"aws:SecureTransport"="false"}}',
                },
                {
                    "keys": ["Sid", "Effect", "Principal", "Action", "Resource"],
                    "effect": "Deny",
                    "principal": "{AWS=aws_iam_role.ecs_task.arn}",
                    "actions": DENIED_TO_APP_ROLE,
                    "resources": both,
                },
            ],
        ),
        "SOURCE (policy contains values known only after apply)",
    )
    # The only way the flag can reach a container is the conditional below, which
    # sets it to "true" when var.customer_deletion_enabled (default false) is true.
    flag_ok = (
        len(re.findall(r'"CUSTOMER_DELETION_ENABLED"', main)) == 1
        and re.search(
            r'var\.customer_deletion_enabled\s*\?\s*\[\s*\{\s*'
            r'name\s*=\s*"CUSTOMER_DELETION_ENABLED"\s*\n\s*value\s*=\s*"true"'
            r'\s*\},?\s*\]\s*:\s*\[\]\)',
            main,
        )
        is not None
    )
    checks.check(
        "CUSTOMER_DELETION_ENABLED is set only by var.customer_deletion_enabled",
        flag_ok,
        "SOURCE (container definitions contain values known only after apply)",
    )
    approval = re.search(
        r'name\s*=\s*"HISTORY_RETENTION_APPROVAL"\s*\n\s*value\s*=\s*(.+)', main
    )
    checks.check(
        "HISTORY_RETENTION_APPROVAL comes only from the approval variable",
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
    # A replaced task definition must register the new revision before the old one is
    # deregistered, or a failure part-way leaves services on an inactive revision.
    replaced = [
        (item.get("change") or {}).get("actions")
        for item in plan.get("resource_changes") or []
        if item.get("type") == "aws_ecs_task_definition"
        and "delete" in ((item.get("change") or {}).get("actions") or [])
    ]
    checks.check(
        "ECS task definitions are replaced create-before-destroy",
        None if not replaced else all(a == ["create", "delete"] for a in replaced),
        "plan (action order)",
    )
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
