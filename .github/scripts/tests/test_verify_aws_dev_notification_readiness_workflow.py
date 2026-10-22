#!/usr/bin/env python3
"""Guard the read-only guarantees of the notification readiness workflow."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / "workflows"
    / "verify-aws-dev-notification-readiness.yml"
).read_text(encoding="utf-8")
DEPLOY = (
    Path(__file__).resolve().parents[2] / "workflows" / "deploy-aws-dev.yml"
).read_text(encoding="utf-8")


class VerifyNotificationReadinessWorkflowTests(unittest.TestCase):
    def test_runs_exactly_the_readiness_module_with_no_arguments(self) -> None:
        commands = re.findall(r'"command":\[([^\]]*)\]', WORKFLOW)
        self.assertEqual(
            commands,
            ['"python","-m","hms_backend.app.tooling.notification_readiness"'],
        )

    def test_uses_the_same_role_task_family_and_network_as_deploy(self) -> None:
        for fragment in (
            "role-to-assume: ${{ vars.AWS_DEV_GITHUB_ROLE_ARN }}",
            "AWS_DEV_MIGRATE_TASK_DEFINITION || 'hms-dev-migrate'",
            "AWS_DEV_ECS_SUBNET_IDS",
            "AWS_DEV_ECS_SECURITY_GROUP_ID",
            '"assignPublicIp": "ENABLED"',
        ):
            self.assertIn(fragment, WORKFLOW)
            self.assertIn(fragment, DEPLOY)

    def test_resolves_the_current_task_definition_instead_of_pinning_a_revision(
        self,
    ) -> None:
        self.assertIn("aws ecs describe-task-definition", WORKFLOW)
        self.assertIsNone(re.search(r"hms-dev-migrate:\d+", WORKFLOW))
        self.assertIsNone(re.search(r"task-definition[^\n]*:\d+\b", WORKFLOW))

    def test_changes_nothing(self) -> None:
        for forbidden in (
            "update-service",
            "terraform",
            "docker push",
            "ecr:",
            "put-parameter",
            "register-task-definition",
            "--desired-count",
        ):
            self.assertNotIn(forbidden, WORKFLOW)
        self.assertEqual(WORKFLOW.count("aws ecs run-task"), 1)

    def test_only_runs_from_main_and_on_demand(self) -> None:
        self.assertIn("workflow_dispatch:", WORKFLOW)
        self.assertNotIn("schedule:", WORKFLOW)
        self.assertNotIn("pull_request", WORKFLOW)
        self.assertIn("github.ref == 'refs/heads/main'", WORKFLOW)

    def test_task_exit_status_gates_the_job(self) -> None:
        for fragment in ("0) echo", "1) echo", "2) echo", "exit 1", "exit 2"):
            self.assertIn(fragment, WORKFLOW)

    def test_requests_least_privilege_token_permissions(self) -> None:
        self.assertIn("contents: read", WORKFLOW)
        self.assertIn("id-token: write", WORKFLOW)
        self.assertNotIn("write-all", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
