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

variable "enable_deletion_protection" {
  description = "Enable deletion protection for stateful resources."
  type        = bool
  default     = false
}
