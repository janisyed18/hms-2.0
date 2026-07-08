# AWS Dev Deployment

This dev foundation deploys HMS 2.0 to AWS in `ap-southeast-2` using:

- Amazon RDS PostgreSQL for the main server database.
- ElastiCache Redis for cache, Celery broker, and Celery results.
- ECS Fargate for the API, Celery worker, Celery beat, and certificate engine.
- S3 for certificate/media object storage.
- S3 + CloudFront for the staff and inspector static apps.
- GitHub Actions OIDC for deployment credentials. No long-lived AWS access keys are stored in GitHub.

The current dev setup intentionally uses temporary AWS URLs. Custom domains and ACM certificates can be added after the environment is stable.

## Local Prerequisites

```bash
aws sts get-caller-identity --profile hf-dev --region ap-southeast-2
terraform version
gh auth status
```

## Provision Dev Infrastructure

```bash
cd infra/terraform/envs/dev
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform fmt -recursive
terraform validate
terraform plan -out dev.tfplan
terraform apply dev.tfplan
```

This creates billable AWS resources. The dev defaults use small instance sizes, but RDS, ElastiCache, ECS, ALB, S3, and CloudFront can still incur charges.

## Configure GitHub Repository Variables

After `terraform apply`, copy the Terraform outputs into GitHub repository variables:

```bash
gh variable set AWS_DEV_GITHUB_ROLE_ARN --body "$(terraform output -raw github_actions_role_arn)"
gh variable set AWS_DEV_ECS_CLUSTER --body "$(terraform output -raw ecs_cluster)"
gh variable set AWS_DEV_API_SERVICE --body "$(terraform output -raw api_service)"
gh variable set AWS_DEV_WORKER_SERVICE --body "$(terraform output -raw worker_service)"
gh variable set AWS_DEV_BEAT_SERVICE --body "$(terraform output -raw beat_service)"
gh variable set AWS_DEV_CERTIFICATE_ENGINE_SERVICE --body "$(terraform output -raw certificate_engine_service)"
gh variable set AWS_DEV_MIGRATE_TASK_DEFINITION --body "$(terraform output -raw migrate_task_definition)"
gh variable set AWS_DEV_ECS_SECURITY_GROUP_ID --body "$(terraform output -raw ecs_security_group_id)"
gh variable set AWS_DEV_STAFF_BUCKET --body "$(terraform output -raw staff_bucket)"
gh variable set AWS_DEV_INSPECTOR_BUCKET --body "$(terraform output -raw inspector_bucket)"
gh variable set AWS_DEV_STAFF_DISTRIBUTION_ID --body "$(terraform output -raw staff_cloudfront_distribution_id)"
gh variable set AWS_DEV_INSPECTOR_DISTRIBUTION_ID --body "$(terraform output -raw inspector_cloudfront_distribution_id)"
terraform output -json ecs_subnet_ids | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)))' | gh variable set AWS_DEV_ECS_SUBNET_IDS --body-file -
```

## Deploy From GitHub Actions

Run the workflow from GitHub:

```bash
gh workflow run deploy-aws-dev.yml --ref codex/aws-dev-deployment-foundation
```

The workflow:

1. Assumes the AWS deploy role with GitHub OIDC.
2. Builds and pushes backend and certificate-engine images to ECR.
3. Runs Alembic migrations and dev seed as a one-off ECS Fargate task.
4. Forces ECS deployments for API, worker, beat, and certificate engine.
5. Builds staff and inspector apps.
6. Uploads static assets to S3.
7. Invalidates CloudFront.

## Test URLs

After Terraform and the first deployment complete:

```bash
terraform output -raw api_url
terraform output -raw staff_url
terraform output -raw inspector_url
```

Then verify:

```bash
curl "$(terraform output -raw api_url)/health"
curl "$(terraform output -raw api_url)/health/ready"
```

## Notes

- Dev ECS tasks run in public subnets with public egress to avoid NAT Gateway cost. Ingress is restricted by security group rules; API traffic enters through the public ALB.
- RDS and Redis are in private subnets and only accept traffic from the ECS task security group.
- Certificate and media files are stored in a private S3 bucket. The backend selects this through `OBJECT_STORAGE_BACKEND=s3`.
- Staff and inspector buckets are private and readable only through CloudFront Origin Access Control.
- The static CloudFront distributions forward `/api/*` and `/health*` to the API ALB so the existing relative frontend API calls continue to work.
