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
3. Create a customer-managed policy from the reviewed document and attach it
   only to `hms-dev-github-actions-terraform`.
4. Set the resulting role ARN as the repository variable
   `AWS_DEV_TERRAFORM_ROLE_ARN`.
5. Verify the trust policy, attached policy version, state bucket access, and
   DynamoDB lock-table access before running the Plan workflow.

The execution role must not receive `AdministratorAccess`, broad IAM identity
administration, or permissions outside the services and `hms-dev` resources
managed by the reviewed Terraform configuration.

## Release Gate

The first Terraform Plan is authorized only after the dedicated role is
created, the GitHub repository variable is configured, and read-only AWS
verification confirms that the live trust allows exactly the two subjects
above. Apply remains subject to the reviewed, encrypted plan gate.
