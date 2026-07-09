output "aws_account_id" {
  description = "AWS account ID used by this Terraform state."
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  description = "AWS region for this environment."
  value       = var.aws_region
}

output "api_url" {
  description = "Temporary public API URL through the ALB."
  value       = "http://${aws_lb.api.dns_name}"
}

output "staff_url" {
  description = "Temporary CloudFront URL for the staff operations console."
  value       = "https://${aws_cloudfront_distribution.staff.domain_name}"
}

output "inspector_url" {
  description = "Temporary CloudFront URL for the inspector app."
  value       = "https://${aws_cloudfront_distribution.inspector.domain_name}"
}

output "media_bucket" {
  description = "Private S3 bucket used for certificates and media."
  value       = aws_s3_bucket.media.bucket
}

output "staff_bucket" {
  description = "Private S3 bucket used for the staff static app."
  value       = aws_s3_bucket.staff.bucket
}

output "inspector_bucket" {
  description = "Private S3 bucket used for the inspector static app."
  value       = aws_s3_bucket.inspector.bucket
}

output "staff_cloudfront_distribution_id" {
  description = "CloudFront distribution ID for the staff app."
  value       = aws_cloudfront_distribution.staff.id
}

output "inspector_cloudfront_distribution_id" {
  description = "CloudFront distribution ID for the inspector app."
  value       = aws_cloudfront_distribution.inspector.id
}

output "api_ecr_repository" {
  description = "ECR repository URL for the backend API/worker/beat image."
  value       = aws_ecr_repository.api.repository_url
}

output "certificate_engine_ecr_repository" {
  description = "ECR repository URL for the certificate engine image."
  value       = aws_ecr_repository.certificate_engine.repository_url
}

output "ecs_cluster" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "api_service" {
  description = "ECS API service name."
  value       = aws_ecs_service.api.name
}

output "worker_service" {
  description = "ECS worker service name."
  value       = aws_ecs_service.worker.name
}

output "beat_service" {
  description = "ECS beat service name."
  value       = aws_ecs_service.beat.name
}

output "certificate_engine_service" {
  description = "ECS certificate engine service name."
  value       = aws_ecs_service.certificate_engine.name
}

output "migrate_task_definition" {
  description = "ECS task definition family for database migrations and dev seed."
  value       = aws_ecs_task_definition.migrate.family
}

output "notification_secret_name" {
  description = "Secrets Manager secret containing SMTP/Twilio notification credentials."
  value       = aws_secretsmanager_secret.notifications.name
}

output "notification_ses_configuration_set" {
  description = "SES configuration set used by outbound HMS notification email."
  value       = aws_sesv2_configuration_set.notifications.configuration_set_name
}

output "notification_sns_topic_arn" {
  description = "SNS topic receiving SES notification delivery/bounce/complaint events."
  value       = aws_sns_topic.notification_events.arn
}

output "notification_events_queue_url" {
  description = "SQS queue subscribed to the notification SNS topic for retained provider events."
  value       = aws_sqs_queue.notification_events.id
}

output "ecs_security_group_id" {
  description = "Security group used by ECS tasks."
  value       = aws_security_group.ecs.id
}

output "ecs_subnet_ids" {
  description = "Subnets used by ECS tasks in the dev environment."
  value       = [for subnet in aws_subnet.public : subnet.id]
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC deployment."
  value       = aws_iam_role.github_actions_deploy.arn
}
