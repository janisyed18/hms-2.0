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

## Review And Apply Dev Infrastructure

Do not run `terraform apply` directly against shared `aws-dev`. Infrastructure
changes use two manual GitHub workflows so the exact plan is reviewed before
state changes are made.

Before the first release, configure the `aws-dev` GitHub Environment with at
least one independent required reviewer and enable prevention of self-review.
Also protect `main` with pull-request-only changes and the six required CI
checks. These repository settings are operational gates and are not managed by
Terraform.

1. From `main`, run **Plan AWS Dev Infrastructure** in GitHub Actions.
2. Review the encrypted plan artifact from that run. It contains
   `tfplan.age` and `tfplan.txt.age`, their ciphertext checksums, and a
   `plan-manifest.json` that records the commit, workflow run, Terraform
   version, and provider lockfile hash. The Plan job never uploads plaintext
   Terraform output. Treat both decrypted files as sensitive infrastructure
   data; the artifact is retained for one day only.
3. Confirm all creates, changes, and deletes are expected. Pay particular
   attention to ECS task definitions, Secrets Manager, CloudFront, ALB, IAM,
   networking, and database resources.
4. Run **Apply AWS Dev Infrastructure**, set `apply_infrastructure` to true,
   and enter the reviewed Plan workflow run ID. The protected `aws-dev`
   Environment approval happens before the plan is downloaded. The workflow
   verifies the plan belongs to the current `main` commit, verifies the
   ciphertext checksums, decrypts the plan with the `aws-dev` Environment
   secret, and applies that artifact without generating a new plan.

This creates billable AWS resources. The dev defaults use small instance sizes, but RDS, ElastiCache, ECS, ALB, S3, and CloudFront can still incur charges.

## Configure GitHub Repository Variables

After the reviewed Apply workflow completes, copy the Terraform outputs into
GitHub repository variables:

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
gh variable set AWS_DEV_API_HEALTH_URL --body "$(terraform output -raw api_url)/health"
terraform output -json ecs_subnet_ids | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)))' | gh variable set AWS_DEV_ECS_SUBNET_IDS --body-file -
```

## Configure Plan Encryption

Generate an age key pair in an approved secrets-management workspace. Keep the
private key out of the repository, local shell history, workflow logs, and
repository-level secrets. Store it only as the `aws-dev` Environment secret
`AWS_DEV_TERRAFORM_PLAN_AGE_PRIVATE_KEY`. Store the matching public recipient
as the repository variable `AWS_DEV_TERRAFORM_PLAN_AGE_RECIPIENT`.

Both workflows download age `v1.2.1` from its tagged upstream release and
verify the archive SHA-256 before using it. Do not replace this with a mutable
package-manager install or an unverified installer.

The independent reviewer must have an approved, auditable method to inspect
the encrypted readable plan before approving Apply. A public repository cannot
use unencrypted GitHub Actions artifacts or logs for this review. Do not run
either infrastructure workflow until that review process is in place.

## Deploy From GitHub Actions

Run **Deploy AWS Dev** manually after the infrastructure plan has been applied.
That workflow refuses to publish images or run migrations when
Terraform drift exists, the edge secret is absent from the API task definition,
or `AWS_DEV_API_HEALTH_URL` is not configured. Run **Deploy AWS Web**
manually only after the API health and scheduling smoke checks pass.

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

## Live Notifications

The backend already supports in-app notifications in all environments. Live
email/SMS delivery on AWS uses:

- AWS SES API for email through the ECS task role.
- Twilio REST API for SMS.
- AWS Secrets Manager for Twilio credentials and the notification webhook secret.
- SES configuration set `$(terraform output -raw notification_ses_configuration_set)`
  publishing delivery/bounce/complaint events to SNS topic
  `$(terraform output -raw notification_sns_topic_arn)`.
- SQS queue `$(terraform output -raw notification_events_queue_url)` subscribed
  to that SNS topic so provider events are retained for later processing.

Terraform creates the notification secret, but the Twilio values must be stored
and the SES sender must be verified before switching ECS to
`NOTIFICATION_CHANNEL_MODE=live`.

```bash
cd infra/terraform/envs/dev
NOTIFICATION_SECRET="$(terraform output -raw notification_secret_name)"
```

Set the Twilio values in your shell without printing them:

```bash
read -rsp "Twilio Account SID: " TWILIO_ACCOUNT_SID; echo
read -rsp "Twilio Auth Token: " TWILIO_AUTH_TOKEN; echo
read -rp "Twilio From number/sender: " TWILIO_FROM
WEBHOOK_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
export TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM WEBHOOK_SECRET
```

Store them in AWS Secrets Manager:

```bash
python3 - <<'PY' > /tmp/hms-notifications-secret.json
import json
import os

print(json.dumps({
    "SMTP_USERNAME": "",
    "SMTP_PASSWORD": "",
    "TWILIO_ACCOUNT_SID": os.environ["TWILIO_ACCOUNT_SID"],
    "TWILIO_AUTH_TOKEN": os.environ["TWILIO_AUTH_TOKEN"],
    "TWILIO_FROM": os.environ["TWILIO_FROM"],
    "NOTIFICATION_WEBHOOK_SECRET": os.environ["WEBHOOK_SECRET"],
}))
PY
aws secretsmanager put-secret-value \
  --profile hf-dev \
  --region ap-southeast-2 \
  --secret-id "$NOTIFICATION_SECRET" \
  --secret-string file:///tmp/hms-notifications-secret.json
rm /tmp/hms-notifications-secret.json
unset TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM WEBHOOK_SECRET
```

Use a real SES-verified From address. Terraform creates the email identity
verification request when `notification_create_ses_email_identity = true`; the
recipient still needs to approve the SES verification email.

```hcl
notification_email_from_address       = "alerts@example.com"
notification_create_ses_email_identity = true
```

After the SES identity is verified and the Twilio secret contains real values,
switch delivery mode:

```hcl
notification_channel_mode = "live"
```

Then run the reviewed **Plan AWS Dev Infrastructure** → **Apply AWS Dev
Infrastructure** procedure above, followed by the manual API release. Do not
apply a locally generated Terraform plan to the shared environment.

Verification:

```bash
aws sesv2 get-configuration-set \
  --profile hf-dev \
  --region ap-southeast-2 \
  --configuration-set-name "$(terraform output -raw notification_ses_configuration_set)"
aws sns get-topic-attributes \
  --profile hf-dev \
  --region ap-southeast-2 \
  --topic-arn "$(terraform output -raw notification_sns_topic_arn)"
aws sqs get-queue-attributes \
  --profile hf-dev \
  --region ap-southeast-2 \
  --queue-url "$(terraform output -raw notification_events_queue_url)" \
  --attribute-names ApproximateNumberOfMessages
aws ecs describe-services \
  --profile hf-dev \
  --region ap-southeast-2 \
  --cluster "$(terraform output -raw ecs_cluster)" \
  --services "$(terraform output -raw worker_service)" >/dev/null
```

## Notes

- Dev ECS tasks run in public subnets with public egress to avoid NAT Gateway cost. Ingress is restricted by security group rules; API traffic enters through the public ALB.
- RDS and Redis are in private subnets and only accept traffic from the ECS task security group.
- Certificate and media files are stored in a private S3 bucket. The backend selects this through `OBJECT_STORAGE_BACKEND=s3`.
- Staff and inspector buckets are private and readable only through CloudFront Origin Access Control.
- The static CloudFront distributions forward `/api/*` and `/health*` to the API ALB so the existing relative frontend API calls continue to work.
