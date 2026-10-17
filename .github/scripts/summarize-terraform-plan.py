#!/usr/bin/env python3
"""Turn ``terraform show -json`` output into a sanitized structural review report.

The report deliberately contains structure only: resource addresses, the action
Terraform will take, and the *names* of top-level attributes that change. It never
prints a before/after value, a planned value, prior state, variables or outputs'
values, so it is safe to publish to a workflow summary even though the plan itself
is sensitive.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

_SAFE = re.compile(r'[^A-Za-z0-9_.\[\]"\-:/ ]')
# A quoted resource-address index, e.g. ["customer-123"] with escapes allowed.
_QUOTED_INDEX = re.compile(r'\["(?:[^"\\]|\\.)*"\]')

# Every action sequence Terraform can emit that we understand. Anything else is a
# release-gate failure, never a silently dropped change.
_ACTIONS = {
    ("no-op",): "no-op",
    ("read",): "read",
    ("create",): "create",
    ("update",): "update",
    ("delete",): "delete",
    ("delete", "create"): "replace",
    ("create", "delete"): "replace",
    ("forget",): "forget",
}


class UnrecognisedPlanError(Exception):
    """The plan contains something this report cannot faithfully describe."""


def clean(text: object) -> str:
    """Keep names readable but strip anything that could carry data."""
    return _SAFE.sub("?", str(text)).replace("|", "?")


def clean_address(address: object) -> str:
    """Sanitise a resource address and redact every quoted index.

    ``for_each`` keys are runtime data (customer ids, names, tokens, ...), so
    ``module.a["customer-123"].x.y["k"]`` is published as
    ``module.a["redacted"].x.y["redacted"]``. Numeric ``count`` indexes stay.
    """
    marker = "\x00"
    text = _QUOTED_INDEX.sub(marker, str(address).replace(marker, "?"))
    stray = text.find('"')
    if stray != -1:
        # An unbalanced quote means we cannot tell where an index ends: drop the
        # remainder rather than risk publishing part of a key.
        text = text[:stray].rstrip("[") + marker
    return '["redacted"]'.join(clean(part) for part in text.split(marker))


def action_of(actions: object) -> str:
    """Map Terraform's action list to a name, or fail closed."""
    if isinstance(actions, list) and all(isinstance(a, str) for a in actions):
        known = _ACTIONS.get(tuple(actions))
        if known is not None:
            return known
    shown = (
        "/".join(clean(a) for a in actions)
        if isinstance(actions, list)
        else "malformed"
    )
    raise UnrecognisedPlanError(f"unrecognised Terraform action sequence: {shown}")


def changed_attributes(change: dict[str, Any]) -> list[str]:
    """Top-level attribute names whose value differs or will be known after apply."""
    before = change.get("before") or {}
    after = change.get("after") or {}
    unknown = change.get("after_unknown") or {}
    names = set(before) | set(after)
    if isinstance(unknown, dict):
        names |= {key for key, value in unknown.items() if value}
    return sorted(
        name
        for name in names
        if before.get(name) != after.get(name)
        or (isinstance(unknown, dict) and unknown.get(name))
    )


def replace_reasons(change: dict[str, Any]) -> list[str]:
    paths = change.get("replace_paths") or []
    return sorted({clean(path[0]) for path in paths if path})


def summarize(plan: dict[str, Any]) -> dict[str, Any]:
    changes: list[dict[str, Any]] = []
    for resource in plan.get("resource_changes") or []:
        change = resource.get("change") or {}
        action = action_of(change.get("actions"))
        if action in ("no-op", "read"):
            continue
        entry: dict[str, Any] = {
            "address": clean_address(resource.get("address", "?")),
            "type": clean(resource.get("type", "?")),
            "action": action,
        }
        if action in ("update", "replace"):
            entry["attributes"] = [clean(n) for n in changed_attributes(change)]
        if action == "replace":
            entry["replace_because"] = replace_reasons(change)
        changes.append(entry)

    drift: list[dict[str, Any]] = []
    for resource in plan.get("resource_drift") or []:
        change = resource.get("change") or {}
        action = action_of(change.get("actions"))
        if action in ("no-op", "read"):
            continue
        drift.append(
            {
                "address": clean_address(resource.get("address", "?")),
                "action": action,
                "attributes": [clean(n) for n in changed_attributes(change)],
            }
        )

    outputs = []
    for name, change in sorted((plan.get("output_changes") or {}).items()):
        action = action_of(change.get("actions"))
        if action != "no-op":
            outputs.append({"name": clean(name), "action": action})

    counts = {"add": 0, "change": 0, "destroy": 0}
    for entry in changes:
        if entry["action"] in ("create", "replace"):
            counts["add"] += 1
        if entry["action"] == "update":
            counts["change"] += 1
        if entry["action"] in ("delete", "replace"):
            counts["destroy"] += 1

    return {
        "terraform_version": clean(plan.get("terraform_version", "?")),
        "applyable": bool(plan.get("applyable")),
        "errored": bool(plan.get("errored")),
        "counts": counts,
        "changes": sorted(changes, key=lambda c: (c["action"], c["address"])),
        "drift": sorted(drift, key=lambda d: d["address"]),
        "outputs": outputs,
    }


def render(summary: dict[str, Any], manifest: dict[str, Any] | None) -> str:
    counts = summary["counts"]
    lines = ["# Terraform plan structural review", ""]
    if manifest:
        lines += [
            f"- Plan run: `{clean(manifest.get('plan_run_id', '?'))}`",
            f"- Commit: `{clean(manifest.get('commit_sha', '?'))}`",
            f"- `tfplan.age` SHA-256: `{clean(manifest.get('plan_ciphertext_sha256', '?'))}`",
            f"- `tfplan.txt.age` SHA-256: `{clean(manifest.get('readable_plan_ciphertext_sha256', '?'))}`",
        ]
    lines += [
        f"- Terraform: `{summary['terraform_version']}`",
        f"- Applyable: `{summary['applyable']}`; errored: `{summary['errored']}`",
        "",
        f"**Plan: {counts['add']} to add, {counts['change']} to change, "
        f"{counts['destroy']} to destroy.**",
        "",
        "Structure only: no before/after values, variables or state are shown.",
        "",
    ]

    risky = [c for c in summary["changes"] if c["action"] in ("delete", "replace")]
    lines.append("## Deletions and replacements")
    if risky:
        for c in risky:
            because = (
                f" (because of: {', '.join(c['replace_because'])})"
                if c.get("replace_because")
                else ""
            )
            lines.append(f"- **{c['action'].upper()}** `{c['address']}`{because}")
    else:
        lines.append("- none")
    lines.append("")

    sensitive_types = ("aws_iam_", "aws_secretsmanager_", "aws_kms_")
    touched = [c for c in summary["changes"] if c["type"].startswith(sensitive_types)]
    lines.append("## IAM, secret and KMS resources")
    if touched:
        for c in touched:
            lines.append(f"- {c['action']} `{c['address']}`")
    else:
        lines.append("- none")
    lines.append("")

    lines += ["## All changes", "", "| Action | Resource | Changed attributes |", "|---|---|---|"]
    for c in summary["changes"]:
        if c["action"] in ("update", "replace"):
            attrs = ", ".join(c["attributes"]) or "-"
        else:
            attrs = "-"
        lines.append(f"| {c['action']} | `{c['address']}` | {attrs} |")
    if not summary["changes"]:
        lines.append("| none | | |")
    lines.append("")

    lines.append("## Drift detected during refresh")
    if summary["drift"]:
        for d in summary["drift"]:
            lines.append(
                f"- {d['action']} `{d['address']}`: {', '.join(d['attributes']) or '-'}"
            )
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Output changes")
    if summary["outputs"]:
        lines += [f"- {o['action']} `{o['name']}`" for o in summary["outputs"]]
    else:
        lines.append("- none")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan-json", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan_json.read_text(encoding="utf-8"))
        manifest = (
            json.loads(args.manifest.read_text(encoding="utf-8"))
            if args.manifest
            else None
        )
    except (FileNotFoundError, json.JSONDecodeError) as error:
        # Never echo the file contents; the type of error is enough.
        print(f"Could not read plan input: {type(error).__name__}", file=sys.stderr)
        return 1
    try:
        report = render(summarize(plan), manifest)
    except UnrecognisedPlanError as error:
        # Refuse to publish a report that might omit a change. Only the action
        # tokens are named; no plan value is echoed.
        print(f"Refusing to publish an incomplete report: {error}", file=sys.stderr)
        return 1
    sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
