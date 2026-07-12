variable "aws_region" {
  description = "AWS region for the dev environment."
  type        = string
  default     = "ap-southeast-2"
}

variable "aws_profile" {
  description = "Local AWS CLI profile used for Terraform runs. GitHub Actions uses OIDC instead."
  type        = string
  default     = "hf-dev"
}

variable "project" {
  description = "Short project name used in AWS resource names."
  type        = string
  default     = "hms"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "dev"
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the deployment role."
  type        = string
  default     = "janisyed18/hms-2.0"
}

variable "github_deploy_refs" {
  description = "GitHub OIDC subject claims allowed to deploy this environment."
  type        = list(string)
  default = [
    "repo:janisyed18/hms-2.0:environment:aws-dev",
    "repo:janisyed18/hms-2.0:ref:refs/heads/main",
    "repo:janisyed18/hms-2.0:ref:refs/heads/codex/aws-dev-deployment-foundation",
  ]
}

variable "vpc_cidr" {
  description = "CIDR block for the dev VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs. ECS dev tasks run here with public egress."
  type        = list(string)
  default     = ["10.42.0.0/24", "10.42.1.0/24"]
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs for RDS and ElastiCache."
  type        = list(string)
  default     = ["10.42.10.0/24", "10.42.11.0/24"]
}

variable "db_name" {
  description = "PostgreSQL database name."
  type        = string
  default     = "hms"
}

variable "db_username" {
  description = "PostgreSQL master username."
  type        = string
  default     = "hms"
}

variable "db_instance_class" {
  description = "RDS instance class for dev."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  description = "Allocated RDS storage in GB."
  type        = number
  default     = 20
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type for dev."
  type        = string
  default     = "cache.t4g.micro"
}

variable "api_desired_count" {
  description = "Desired count for the API ECS service."
  type        = number
  default     = 1
}

variable "worker_desired_count" {
  description = "Desired count for the Celery worker ECS service."
  type        = number
  default     = 1
}

variable "beat_desired_count" {
  description = "Desired count for the Celery beat ECS service."
  type        = number
  default     = 1
}

variable "certificate_engine_desired_count" {
  description = "Desired count for the certificate engine ECS service."
  type        = number
  default     = 1
}

variable "image_tag" {
  description = "Container image tag used by ECS task definitions. CI pushes latest and forces new deployments."
  type        = string
  default     = "latest"
}

variable "auth_mfa_key_version" {
  description = "Current version used to encrypt new TOTP secrets. Retain older keys in the app secret during rotation."
  type        = number
  default     = 1

  validation {
    condition     = var.auth_mfa_key_version >= 1 && floor(var.auth_mfa_key_version) == var.auth_mfa_key_version
    error_message = "auth_mfa_key_version must be a positive integer."
  }
}

variable "enable_deletion_protection" {
  description = "Enable deletion protection for stateful resources."
  type        = bool
  default     = false
}

variable "notification_channel_mode" {
  description = "Notification delivery mode for ECS tasks. Use live only after SES/Twilio secrets are populated."
  type        = string
  default     = "console"

  validation {
    condition     = contains(["console", "live"], var.notification_channel_mode)
    error_message = "notification_channel_mode must be console or live."
  }
}

variable "notification_sender_name" {
  description = "Display name used in outbound notification emails."
  type        = string
  default     = "BAT Engineering"
}

variable "notification_email_provider" {
  description = "Live email provider. AWS dev uses aws_ses so ECS task role credentials are used instead of SMTP secrets."
  type        = string
  default     = "aws_ses"

  validation {
    condition     = contains(["smtp", "aws_ses"], var.notification_email_provider)
    error_message = "notification_email_provider must be smtp or aws_ses."
  }
}

variable "notification_smtp_host" {
  description = "SMTP hostname used for live email notifications."
  type        = string
  default     = "email-smtp.ap-southeast-2.amazonaws.com"
}

variable "notification_smtp_port" {
  description = "SMTP port used for live email notifications."
  type        = number
  default     = 587
}

variable "notification_smtp_use_tls" {
  description = "Whether the SMTP adapter should negotiate STARTTLS."
  type        = bool
  default     = true
}

variable "notification_email_from_address" {
  description = "Verified SES email identity used as the From address."
  type        = string
  default     = "no-reply@hftechnologies.com.au"
}

variable "notification_ses_region" {
  description = "AWS region used by the SES API adapter. Defaults to aws_region."
  type        = string
  default     = ""
}

variable "notification_ses_configuration_set_name" {
  description = "Optional existing SES configuration set name. Defaults to hms-dev-notifications."
  type        = string
  default     = ""
}

variable "notification_create_ses_email_identity" {
  description = "Create an SES email identity for notification_email_from_address. Verification email approval is still manual."
  type        = bool
  default     = true
}

variable "notification_smtp_username" {
  description = "Initial SES SMTP username stored in Secrets Manager. Prefer updating the created secret directly for rotations."
  type        = string
  default     = ""
  sensitive   = true
}

variable "notification_smtp_password" {
  description = "Initial SES SMTP password stored in Secrets Manager. Prefer updating the created secret directly for rotations."
  type        = string
  default     = ""
  sensitive   = true
}

variable "notification_twilio_account_sid" {
  description = "Initial Twilio Account SID stored in Secrets Manager."
  type        = string
  default     = ""
  sensitive   = true
}

variable "notification_twilio_auth_token" {
  description = "Initial Twilio Auth Token stored in Secrets Manager."
  type        = string
  default     = ""
  sensitive   = true
}

variable "notification_twilio_from" {
  description = "Initial Twilio sender, E.164 number or alphanumeric sender ID, stored in Secrets Manager."
  type        = string
  default     = ""
  sensitive   = true
}
