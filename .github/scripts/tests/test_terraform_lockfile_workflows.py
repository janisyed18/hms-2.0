#!/usr/bin/env python3
"""Guard immutable provider-lock behavior in AWS Terraform release workflows."""

from __future__ import annotations

import unittest
from pathlib import Path


WORKFLOW_DIRECTORY = Path(__file__).resolve().parents[2] / "workflows"
PLAN_WORKFLOW = (WORKFLOW_DIRECTORY / "plan-aws-dev-infrastructure.yml").read_text(
    encoding="utf-8"
)
APPLY_WORKFLOW = (WORKFLOW_DIRECTORY / "apply-aws-dev-infrastructure.yml").read_text(
    encoding="utf-8"
)
DEPLOY_WORKFLOW = (WORKFLOW_DIRECTORY / "deploy-aws-dev.yml").read_text(
    encoding="utf-8"
)


class TerraformLockfileWorkflowTests(unittest.TestCase):
    def test_plan_initializes_with_an_immutable_source_lockfile(self) -> None:
        self.assertIn('lockfile_sha_before="$(sha256sum .terraform.lock.hcl', PLAN_WORKFLOW)
        self.assertIn("terraform init -input=false -lockfile=readonly", PLAN_WORKFLOW)
        self.assertIn('lockfile_sha_after="$(sha256sum .terraform.lock.hcl', PLAN_WORKFLOW)
        self.assertIn('test "$lockfile_sha_before" = "$lockfile_sha_after"', PLAN_WORKFLOW)

    def test_apply_verifies_the_checked_out_lock_before_initialization(self) -> None:
        verifier = APPLY_WORKFLOW.index("verify-terraform-plan-artifact.py")
        initialization = APPLY_WORKFLOW.index(
            "terraform init -input=false -lockfile=readonly"
        )

        self.assertLess(verifier, initialization)

    def test_deployment_preflight_uses_the_pinned_cli_and_readonly_lock(self) -> None:
        self.assertIn("TERRAFORM_VERSION: 1.15.8", DEPLOY_WORKFLOW)
        self.assertIn("terraform_version: ${{ env.TERRAFORM_VERSION }}", DEPLOY_WORKFLOW)
        self.assertIn("terraform init -input=false -lockfile=readonly", DEPLOY_WORKFLOW)


if __name__ == "__main__":
    unittest.main()
