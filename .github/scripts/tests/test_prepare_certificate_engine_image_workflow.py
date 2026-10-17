#!/usr/bin/env python3
"""Guard the narrow, build-only scope of the certificate engine image workflow."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / "workflows"
    / "prepare-aws-dev-certificate-engine-image.yml"
).read_text(encoding="utf-8")


def step(name: str) -> str:
    start = WORKFLOW.index(f"- name: {name}")
    nxt = WORKFLOW.find("\n      - ", start + 1)
    return WORKFLOW[start : nxt if nxt != -1 else len(WORKFLOW)]


class PrepareCertificateEngineImageWorkflowTests(unittest.TestCase):
    def test_it_is_manual_only_and_confirmation_gated(self) -> None:
        trigger = WORKFLOW.split("\npermissions:")[0]
        self.assertIn("workflow_dispatch:", trigger)
        for other in ("push:", "pull_request", "schedule:", "workflow_run:"):
            self.assertNotIn(other, trigger)
        self.assertIn("prepare_certificate_engine_image:", WORKFLOW)
        self.assertRegex(
            WORKFLOW,
            r"prepare_certificate_engine_image:\s+description:.*\n\s+required: true\n"
            r"\s+default: false\n\s+type: boolean",
        )
        self.assertIn("if: ${{ inputs.prepare_certificate_engine_image }}", WORKFLOW)

    def test_permissions_are_minimal(self) -> None:
        block = WORKFLOW.split("\npermissions:\n")[1].split("\n\n")[0]
        self.assertEqual(
            [line.strip() for line in block.splitlines()],
            ["contents: read", "id-token: write"],
        )

    def test_it_runs_only_from_main_in_the_protected_environment(self) -> None:
        self.assertIn("environment: aws-dev", WORKFLOW)
        self.assertIn("ref: main", WORKFLOW)
        self.assertIn('test "$GITHUB_REF" = "refs/heads/main"', WORKFLOW)
        self.assertIn('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"', WORKFLOW)

    def test_it_uses_only_the_application_delivery_role(self) -> None:
        self.assertEqual(WORKFLOW.count("role-to-assume:"), 1)
        self.assertIn("role-to-assume: ${{ vars.AWS_DEV_GITHUB_ROLE_ARN }}", WORKFLOW)
        self.assertNotIn("TERRAFORM", WORKFLOW.upper())

    def test_it_builds_only_the_certificate_service_into_the_fixed_repository(
        self,
    ) -> None:
        self.assertIn(
            "ECR_CERTIFICATE_ENGINE_REPOSITORY: hms-dev-certificate-engine", WORKFLOW
        )
        build = step("Build the certificate engine image")
        self.assertIn("services/certificate", build)
        self.assertEqual(build.count("docker build"), 1)
        self.assertIn('${GITHUB_SHA}"', build)

    def test_it_performs_no_operations_beyond_building_and_publishing(self) -> None:
        for forbidden in (
            "aws ecs",
            "aws secretsmanager",
            "get-secret-value",
            "secretsmanager",
            "run-task",
            "update-service",
            "force-new-deployment",
            "register-task-definition",
            "terraform",
            "aws iam",
            "aws sts",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, WORKFLOW.lower())

    def test_image_is_verified_before_anything_is_pushed(self) -> None:
        self.assertLess(
            WORKFLOW.index("Verify the image before publishing"),
            WORKFLOW.index("docker push"),
        )
        verify = step("Verify the image before publishing")
        self.assertIn("import hms_certificate.pki, hms_certificate.signing", verify)
        self.assertIn("HMS_CERT_DEV_AUTOGENERATE_SIGNER=false", verify)
        self.assertIn('"$exit_code" -eq 124', verify)

    def test_commit_tag_is_pushed_before_latest(self) -> None:
        publish = step("Publish the commit tag, then latest")
        self.assertLess(publish.index("${GITHUB_SHA}"), publish.index(":latest"))
        self.assertEqual(len(re.findall(r"docker push", WORKFLOW)), 2)

    def test_latest_must_resolve_to_the_commit_tag_digest(self) -> None:
        check = step("Verify latest resolves to the commit tag")
        self.assertIn("set -euo pipefail", check)
        self.assertIn('digest_of "$GITHUB_SHA"', check)
        self.assertIn("digest_of latest", check)
        self.assertIn('[ "$sha_digest" != "$latest_digest" ]', check)
        self.assertIn("sha256:*", check)

    def test_no_credentials_are_printed(self) -> None:
        for forbidden in ("get-login-password", "docker login", "set -x", "AWS_SECRET"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, WORKFLOW)


if __name__ == "__main__":
    unittest.main()
