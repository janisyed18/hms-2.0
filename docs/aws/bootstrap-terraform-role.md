# AWS Dev Terraform Role Bootstrap

The shared `aws-dev` Terraform state must not manage the credentials used to
apply that same state. Bootstrap the dedicated execution role once with an
authenticated administrator, then maintain its policy as a separately reviewed
infrastructure-security change.

## Role Boundary

- Role name: `hms-dev-github-actions-terraform`
- GitHub repository: `janisyed18/hms-2.0`
- Allowed OIDC subjects:
  - `repo:janisyed18/hms-2.0:ref:refs/heads/main`
  - `repo:janisyed18/hms-2.0:environment:aws-dev`
- State bucket: `hms-dev-terraform-state-558215002582-ap-southeast-2`
- State lock table: `hms-dev-terraform-locks`

The existing `hms-dev-github-actions-deploy` role is exclusively for ECR,
ECS, static-web, and CloudFront application delivery. Do not attach Terraform
permissions to it.

## Bootstrap Controls

1. Review the role trust and policy documents with the application change that
   introduces or changes Terraform-managed AWS resources.
2. Use an SSO administrator session only for the one-time bootstrap or a
   reviewed policy change. Do not use long-lived IAM user keys.
3. Create the role from
   [`bootstrap/terraform-role-trust-policy.json`](bootstrap/terraform-role-trust-policy.json)
   and attach the five reviewed customer-managed policies in
   [`bootstrap/`](bootstrap/). Each policy stays below IAM's managed-policy
   size limit; together they define the complete execution boundary.
4. Set the resulting role ARN as the repository variable
   `AWS_DEV_TERRAFORM_ROLE_ARN`.
5. Verify the trust policy, attached policy version, state bucket access, and
   DynamoDB lock-table access before running the Plan workflow.

The execution role must not receive `AdministratorAccess`, broad IAM identity
administration, or permissions outside the services and `hms-dev` resources
managed by the reviewed Terraform configuration.

## Reviewed Bootstrap Commands

Run these commands only after this PR is merged and the policy documents have
been independently reviewed. They create the bootstrap-managed execution role;
the shared Terraform state must never manage this role or its policy.

```bash
ROLE_NAME=hms-dev-github-actions-terraform
ACCOUNT_ID=558215002582
REGION=ap-southeast-2

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://docs/aws/bootstrap/terraform-role-trust-policy.json \
  --max-session-duration 3600 \
  --tags Key=Project,Value=HMS Key=Environment,Value=dev Key=ManagedBy,Value=bootstrap

for POLICY_FILE in \
  terraform-role-state-policy.json \
  terraform-role-read-policy.json \
  terraform-role-infrastructure-policy.json \
  terraform-role-delivery-iam-policy.json \
  terraform-role-pki-guard-policy.json; do
  POLICY_NAME="hms-dev-github-actions-terraform-${POLICY_FILE#terraform-role-}"
  POLICY_NAME="${POLICY_NAME%.json}"
  POLICY_ARN=$(aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document "file://docs/aws/bootstrap/$POLICY_FILE" \
    --description "Least-privilege Terraform execution for HMS dev" \
    --query 'Policy.Arn' \
    --output text)
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
done

aws iam get-role --role-name "$ROLE_NAME"
aws iam list-attached-role-policies --role-name "$ROLE_NAME"
```

### Reviewed policy update: signing PKI

The role already exists in AWS DEV, so the signing-PKI change is applied as a
reviewed policy update by an SSO administrator, **before** the first Plan that
includes the PKI resources. It changes one existing policy and adds one:

- `terraform-role-delivery-iam-policy.json` (new version): lets the role attach
  `AmazonECSTaskExecutionRolePolicy` to the new certificate-engine execution role
  and manage the optional `hms-dev-pki-provisioner` role.
- `terraform-role-pki-guard-policy.json` (new policy): allows the secret
  *resource policy* actions on `hms-dev-pki-*` only, and carries explicit **Denies**
  so the Terraform role can never read or change the signing key material:
  `GetSecretValue`/`PutSecretValue`/`UpdateSecret` and related on the root CA key and
  signer secrets, and any write to the root CA certificate (the trust anchor). An
  identity-policy Deny holds even if a secret resource policy is later altered.

```bash
ROLE_NAME=hms-dev-github-actions-terraform
ACCOUNT_ID=558215002582

# 1. New default version of the existing delivery/IAM policy.
aws iam create-policy-version \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/hms-dev-github-actions-terraform-delivery-iam-policy" \
  --policy-document file://docs/aws/bootstrap/terraform-role-delivery-iam-policy.json \
  --set-as-default

# 2. New guard policy, attached to the role.
POLICY_ARN=$(aws iam create-policy \
  --policy-name hms-dev-github-actions-terraform-pki-guard-policy \
  --policy-document file://docs/aws/bootstrap/terraform-role-pki-guard-policy.json \
  --description "Terraform execution: signing PKI secret policies; never key material" \
  --query 'Policy.Arn' --output text)
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
```

Verify the live result before running the Plan (no secret values are read):

```bash
ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}
for ARN in \
  "arn:aws:secretsmanager:ap-southeast-2:${ACCOUNT_ID}:secret:hms-dev-pki-root-ca-key-AbCdEf" \
  "arn:aws:secretsmanager:ap-southeast-2:${ACCOUNT_ID}:secret:hms-dev-pki-signer-AbCdEf"; do
  aws iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
    --action-names secretsmanager:GetSecretValue secretsmanager:PutSecretValue \
    --resource-arns "$ARN" \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
done   # every line must read explicitDeny
aws iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
  --action-names secretsmanager:PutResourcePolicy \
  --resource-arns "arn:aws:secretsmanager:ap-southeast-2:${ACCOUNT_ID}:secret:hms-dev-pki-signer-AbCdEf" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text   # allowed
aws iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
  --action-names iam:AttachRolePolicy \
  --resource-arns "arn:aws:iam::${ACCOUNT_ID}:role/hms-dev-ecs-execution-certificate-engine" \
  --context-entries "ContextKeyName=iam:PolicyARN,ContextKeyValues=arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy,ContextKeyType=string" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text   # allowed
```

Do not execute a Terraform Plan or Apply as part of this bootstrap. Record the
role ARN, then set it as `AWS_DEV_TERRAFORM_ROLE_ARN` through the GitHub
repository settings. The workflows reject an empty value and reject a value
that reuses `AWS_DEV_GITHUB_ROLE_ARN`.

## Policy Scope

The identity policy is intentionally explicit rather than using service or
action wildcards. It permits only the backend, discovery operations, and AWS
services represented by `infra/terraform/envs/dev/main.tf`. A few AWS create
and discovery APIs cannot support resource-level IAM constraints; those entries
use named actions only and are limited to the HMS dev services listed in the
policy. IAM mutation is limited to the ECS task identities, the existing
application deployment identity and the optional PKI provisioner role. An explicit deny prevents the Terraform role
from changing its own trust or permissions.

Any Terraform resource that introduces a new AWS service or a new IAM identity
requires a reviewed update to this policy before it can be applied. Never solve
an authorization failure by adding `AdministratorAccess` or an `Action: "*"`
statement.

## Release Gate

The first Terraform Plan is authorized only after the dedicated role is
created, the GitHub repository variable is configured, and read-only AWS
verification confirms that the live trust allows exactly the two subjects
above. Apply remains subject to the reviewed, encrypted plan gate.
