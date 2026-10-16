#!/usr/bin/env python3
"""Guard the release controls in the manual AWS dev API workflow."""

from __future__ import annotations

import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2] / "workflows" / "deploy-aws-dev.yml"
).read_text(encoding="utf-8")


class DeployAwsDevWorkflowTests(unittest.TestCase):
    def test_terraform_preflight_clears_the_local_profile_default(self) -> None:
        self.assertIn('TF_VAR_aws_profile: ""', WORKFLOW)

    def test_terraform_preflight_uses_the_dedicated_role(self) -> None:
        preflight = WORKFLOW.index("Configure Terraform preflight credentials")
        application = WORKFLOW.index("Configure application deployment credentials")

        self.assertLess(preflight, application)
        self.assertIn(
            "role-to-assume: ${{ vars.AWS_DEV_TERRAFORM_ROLE_ARN }}",
            WORKFLOW[preflight:application],
        )
        self.assertIn(
            "role-to-assume: ${{ vars.AWS_DEV_GITHUB_ROLE_ARN }}",
            WORKFLOW[application:],
        )

    def test_preflight_plan_output_is_suppressed_and_cleaned(self) -> None:
        self.assertIn('plan_log="$(mktemp)"', WORKFLOW)
        self.assertIn(
            'terraform plan -detailed-exitcode -input=false -out=tfplan '
            '>"$plan_log" 2>&1',
            WORKFLOW,
        )
        self.assertIn(
            'shred --remove --zero --iterations=1 tfplan "$plan_log"',
            WORKFLOW,
        )

    def test_health_variable_is_used_as_a_complete_endpoint(self) -> None:
        self.assertIn('"$API_HEALTH_URL"', WORKFLOW)
        self.assertNotIn('"$API_HEALTH_URL/health"', WORKFLOW)


if __name__ == "__main__":
    unittest.main()
