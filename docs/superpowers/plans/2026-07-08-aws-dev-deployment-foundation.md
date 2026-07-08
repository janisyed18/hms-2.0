# AWS Dev Deployment Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare a dev AWS deployment foundation for HMS 2.0 using RDS PostgreSQL, ElastiCache Redis, ECS Fargate, S3, CloudFront, and GitHub Actions OIDC.

**Architecture:** The backend keeps its existing modular-monolith deployment shape and adds an S3 implementation behind the existing object storage abstraction. Terraform provisions a dev AWS environment with public ALB/API ingress, private RDS/Redis data services, ECS Fargate services, S3/CloudFront static hosting, and an OIDC role for GitHub Actions. The deploy workflow builds/pushes images, runs migrations, rolls ECS services, uploads frontends, and invalidates CloudFront.

**Tech Stack:** FastAPI, Celery, PostgreSQL, Redis, ECS Fargate, RDS, ElastiCache, S3, CloudFront, ECR, GitHub Actions OIDC, Terraform.

---

### Task 1: Backend S3 Object Storage

**Files:**
- Modify: `backend/src/hms_backend/app/core/config.py`
- Modify: `backend/src/hms_backend/app/core/object_storage.py`
- Modify: `backend/pyproject.toml`
- Test: `backend/tests/test_object_storage.py`

- [x] **Step 1: Write the failing test**

Create tests that instantiate `S3ObjectStorage` with a fake S3 client, verify `put/get/exists`, verify missing object handling, reject path traversal keys, and verify the settings-based factory selects the S3 backend.

- [x] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_object_storage.py -q`

Expected red result: import error because `S3ObjectStorage` does not exist.

- [x] **Step 3: Write minimal implementation**

Add `object_storage_backend`, `object_storage_s3_bucket`, `object_storage_s3_prefix`, and `object_storage_s3_region` settings. Add `S3ObjectStorage` with lazy `boto3` client creation and no caller-facing AWS SDK leakage.

- [x] **Step 4: Run test to verify it passes**

Run: `cd backend && uv sync --dev && uv run pytest tests/test_object_storage.py -q`

Expected green result: `4 passed`.

### Task 2: Terraform Dev Foundation

**Files:**
- Create: `infra/terraform/envs/dev/versions.tf`
- Create: `infra/terraform/envs/dev/variables.tf`
- Create: `infra/terraform/envs/dev/main.tf`
- Create: `infra/terraform/envs/dev/outputs.tf`
- Create: `infra/terraform/envs/dev/terraform.tfvars.example`

- [x] **Step 1: Define provider and variables**

Use AWS provider in `ap-southeast-2` with local profile `hf-dev`, plus `random` and `tls` providers for generated secrets and GitHub OIDC thumbprint discovery.

- [x] **Step 2: Define AWS resources**

Provision VPC, public/private subnets, RDS PostgreSQL, ElastiCache Redis, S3 buckets, ECR repositories, ECS cluster/services/tasks, ALB, CloudFront distributions, Cloud Map service discovery, Secrets Manager, and GitHub OIDC deploy role.

- [x] **Step 3: Validate Terraform**

Run:

```bash
cd infra/terraform/envs/dev
terraform init
terraform fmt -recursive
terraform validate
```

Expected: Terraform initializes, formats, validates without errors, and produces a plan.

### Task 3: GitHub Actions Dev Deployment

**Files:**
- Create: `.github/workflows/deploy-aws-dev.yml`
- Create: `docs/aws/dev-deployment.md`

- [x] **Step 1: Add deploy workflow**

Add a GitHub Actions workflow that authenticates with AWS OIDC, builds/pushes backend and certificate-engine images, runs ECS migrations, updates ECS services, builds frontends, uploads them to S3, and invalidates CloudFront.

- [x] **Step 2: Add runbook**

Document Terraform apply, GitHub repository variable setup, workflow trigger, and temporary output URLs.

- [x] **Step 3: Validate workflow and docs**

Run YAML parsing/lint-equivalent checks available locally, inspect required repository variables, and run `git diff --check`.

Expected: no YAML syntax issues and no whitespace errors.
