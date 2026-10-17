#!/usr/bin/env python3
"""Guard the narrow, build-only scope of the certificate engine image workflow."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
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


def run_block(name: str) -> str:
    """The shell body of a step, de-indented (GitHub runs it with bash)."""
    body = step(name).split("run: |\n", 1)[1]
    return "\n".join(line[10:] if line.startswith(" " * 10) else line
                     for line in body.splitlines())


def run_guard(fake_aws_script: str) -> subprocess.CompletedProcess:
    """Run the overwrite guard with a fake `aws` that behaves as scripted."""
    with tempfile.TemporaryDirectory() as directory:
        fake = Path(directory) / "aws"
        fake.write_text("#!/bin/bash\n" + fake_aws_script + "\n", encoding="utf-8")
        fake.chmod(0o755)
        env = {
            **os.environ,
            "PATH": f"{directory}:{os.environ['PATH']}",
            "ECR_CERTIFICATE_ENGINE_REPOSITORY": "hms-dev-certificate-engine",
            "GITHUB_SHA": "abc123",
        }
        return subprocess.run(
            ["bash", "-e", "-c", run_block("Refuse to overwrite an existing commit tag")],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )


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

    def test_the_commit_tag_is_not_called_immutable(self) -> None:
        # The ECR repository allows overwrites; the guard is best-effort.
        self.assertNotIn("immutable", WORKFLOW.lower())

    def test_image_is_built_and_verified_before_any_aws_credential(self) -> None:
        credentials = WORKFLOW.index("- name: Configure AWS credentials")
        self.assertLess(WORKFLOW.index("- name: Build the certificate engine image"), credentials)
        self.assertLess(WORKFLOW.index("- name: Verify the image before publishing"), credentials)
        self.assertNotIn("ecr.outputs.registry", step("Build the certificate engine image"))

    def test_overwrite_guard_runs_before_any_push(self) -> None:
        self.assertLess(
            WORKFLOW.index("- name: Refuse to overwrite an existing commit tag"),
            WORKFLOW.index("docker push"),
        )

    def test_guard_refuses_when_the_commit_tag_already_exists(self) -> None:
        result = run_guard('echo \'{"imageDetails": []}\'; exit 0')
        self.assertEqual(result.returncode, 1)
        self.assertIn("refusing to overwrite", result.stderr)

    def test_guard_allows_only_a_definite_image_not_found(self) -> None:
        result = run_guard(
            "echo 'An error occurred (ImageNotFoundException) when calling "
            "the DescribeImages operation' >&2; exit 254"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("free", result.stdout)

    def test_guard_fails_closed_on_any_other_lookup_error(self) -> None:
        for message in (
            "An error occurred (AccessDeniedException) when calling DescribeImages",
            "An error occurred (RepositoryNotFoundException) when calling DescribeImages",
            "Could not connect to the endpoint URL",
            "",
        ):
            with self.subTest(message=message):
                result = run_guard(f"echo '{message}' >&2; exit 254")
                self.assertEqual(result.returncode, 1)
                self.assertIn("refusing to push", result.stderr)

    def test_no_credentials_are_printed(self) -> None:
        for forbidden in ("get-login-password", "docker login", "set -x", "AWS_SECRET"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, WORKFLOW)


if __name__ == "__main__":
    unittest.main()
