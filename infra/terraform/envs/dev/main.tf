data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "tls_certificate" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  name = "${var.project}-${var.environment}"

  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  common_tags = {
    Project     = "BAT HMS 2.0"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  api_ecr_name                = "${local.name}-api"
  certificate_engine_ecr_name = "${local.name}-certificate-engine"

  media_prefix = var.environment

  cloudfront_api_origin_id       = "${local.name}-api-alb"
  cloudfront_staff_origin_id     = "${local.name}-staff-s3"
  cloudfront_inspector_origin_id = "${local.name}-inspector-s3"

  certificate_service_dns = "certificate-engine.${aws_service_discovery_private_dns_namespace.this.name}"

  app_secret_arn          = aws_secretsmanager_secret.app.arn
  notification_secret_arn = aws_secretsmanager_secret.notifications.arn
  notification_ses_configuration_set_name = (
    var.notification_ses_configuration_set_name != ""
    ? var.notification_ses_configuration_set_name
    : "${local.name}-notifications"
  )

  notification_secret_environment = [
    {
      name      = "SMTP_USERNAME"
      valueFrom = "${local.notification_secret_arn}:SMTP_USERNAME::"
    },
    {
      name      = "SMTP_PASSWORD"
      valueFrom = "${local.notification_secret_arn}:SMTP_PASSWORD::"
    },
    {
      name      = "TWILIO_ACCOUNT_SID"
      valueFrom = "${local.notification_secret_arn}:TWILIO_ACCOUNT_SID::"
    },
    {
      name      = "TWILIO_AUTH_TOKEN"
      valueFrom = "${local.notification_secret_arn}:TWILIO_AUTH_TOKEN::"
    },
    {
      name      = "TWILIO_FROM"
      valueFrom = "${local.notification_secret_arn}:TWILIO_FROM::"
    },
    {
      name      = "NOTIFICATION_WEBHOOK_SECRET"
      valueFrom = "${local.notification_secret_arn}:NOTIFICATION_WEBHOOK_SECRET::"
    },
  ]

  backend_secret_environment = concat([
    {
      name      = "DATABASE_URL"
      valueFrom = "${local.app_secret_arn}:DATABASE_URL::"
    },
    {
      name      = "AUTH_BEARER_HMAC_SECRET"
      valueFrom = "${local.app_secret_arn}:AUTH_BEARER_HMAC_SECRET::"
    },
    {
      name      = "AUTH_MFA_ENCRYPTION_KEY"
      valueFrom = "${local.app_secret_arn}:AUTH_MFA_ENCRYPTION_KEY::"
    },
    {
      name      = "AUTH_MFA_ENCRYPTION_KEYS"
      valueFrom = "${local.app_secret_arn}:AUTH_MFA_ENCRYPTION_KEYS::"
    },
    {
      name      = "AUTH_RECOVERY_CODE_PEPPER"
      valueFrom = "${local.app_secret_arn}:AUTH_RECOVERY_CODE_PEPPER::"
    },
  ], local.notification_secret_environment)

  backend_environment = [
    {
      name  = "ENVIRONMENT"
      value = var.environment
    },
    {
      name  = "PUBLIC_BASE_URL"
      value = "http://${aws_lb.api.dns_name}"
    },
    {
      name  = "REDIS_URL"
      value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379/0"
    },
    {
      name  = "CERTIFICATE_SERVICE_ADDRESS"
      value = "${local.certificate_service_dns}:50051"
    },
    {
      name  = "OBJECT_STORAGE_BACKEND"
      value = "s3"
    },
    {
      name  = "OBJECT_STORAGE_S3_BUCKET"
      value = aws_s3_bucket.media.bucket
    },
    {
      name  = "OBJECT_STORAGE_S3_PREFIX"
      value = local.media_prefix
    },
    {
      name  = "OBJECT_STORAGE_S3_REGION"
      value = var.aws_region
    },
    {
      name  = "AUTH_MODE"
      value = "bearer"
    },
    {
      name  = "AUTH_DEV_HEADERS_ENABLED"
      value = "false"
    },
    {
      name  = "AUTH_DEV_ALLOW_ROLE_FALLBACK"
      value = "false"
    },
    {
      name  = "AUTH_BROWSER_LOGIN_ENABLED"
      value = "true"
    },
    {
      name  = "AUTH_BROWSER_ALLOWED_ORIGINS"
      value = jsonencode(["https://${aws_cloudfront_distribution.staff.domain_name}"])
    },
    {
      name  = "AUTH_BROWSER_COOKIE_SECURE"
      value = "true"
    },
    {
      name  = "AUTH_MFA_KEY_VERSION"
      value = tostring(var.auth_mfa_key_version)
    },
    {
      name  = "NOTIFICATION_CHANNEL_MODE"
      value = var.notification_channel_mode
    },
    {
      name  = "NOTIFICATION_SENDER_NAME"
      value = var.notification_sender_name
    },
    {
      name  = "NOTIFICATION_EMAIL_PROVIDER"
      value = var.notification_email_provider
    },
    {
      name  = "SMTP_HOST"
      value = var.notification_smtp_host
    },
    {
      name  = "SMTP_PORT"
      value = tostring(var.notification_smtp_port)
    },
    {
      name  = "SMTP_USE_TLS"
      value = tostring(var.notification_smtp_use_tls)
    },
    {
      name  = "EMAIL_FROM_ADDRESS"
      value = var.notification_email_from_address
    },
    {
      name  = "NOTIFICATION_SES_REGION"
      value = var.notification_ses_region != "" ? var.notification_ses_region : var.aws_region
    },
    {
      name  = "NOTIFICATION_SES_CONFIGURATION_SET"
      value = local.notification_ses_configuration_set_name
    },
    {
      name  = "ISSUER_NAME"
      value = "BAT Engineering Pty Ltd"
    },
  ]

  backend_image            = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
  certificate_engine_image = "${aws_ecr_repository.certificate_engine.repository_url}:${var.image_tag}"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = local.name
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = local.name
  }
}

resource "aws_subnet" "public" {
  for_each = {
    for index, cidr in var.public_subnet_cidrs : index => cidr
  }

  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value
  availability_zone       = local.azs[tonumber(each.key)]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name}-public-${each.key}"
  }
}

resource "aws_subnet" "private" {
  for_each = {
    for index, cidr in var.private_subnet_cidrs : index => cidr
  }

  vpc_id            = aws_vpc.this.id
  cidr_block        = each.value
  availability_zone = local.azs[tonumber(each.key)]

  tags = {
    Name = "${local.name}-private-${each.key}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "${local.name}-public"
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTP ingress for the HMS dev API"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Temporary dev HTTP"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ecs" {
  name        = "${local.name}-ecs"
  description = "ECS task ingress from ALB and internal task traffic"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    description     = "API from ALB"
  }

  ingress {
    from_port   = 50051
    to_port     = 50051
    protocol    = "tcp"
    self        = true
    description = "Certificate engine from HMS ECS tasks"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL ingress from ECS tasks"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
    description     = "PostgreSQL from HMS tasks"
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis ingress from ECS tasks"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
    description     = "Redis from HMS tasks"
  }
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "auth_hmac" {
  length  = 48
  special = false
}

resource "random_password" "auth_mfa" {
  length  = 43
  special = false
}

resource "random_password" "auth_recovery_pepper" {
  length  = 48
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-db"
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
}

resource "aws_db_instance" "postgres" {
  identifier              = "${local.name}-postgres"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.db_instance_class
  allocated_storage       = var.db_allocated_storage_gb
  db_name                 = var.db_name
  username                = var.db_username
  password                = random_password.db.result
  db_subnet_group_name    = aws_db_subnet_group.this.name
  vpc_security_group_ids  = [aws_security_group.database.id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  deletion_protection     = var.enable_deletion_protection
  backup_retention_period = 7
  storage_encrypted       = true
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${local.name}-redis"
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id         = "${local.name}-redis"
  engine             = "redis"
  node_type          = var.redis_node_type
  num_cache_nodes    = 1
  port               = 6379
  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.redis.id]
  apply_immediately  = true
}

resource "aws_s3_bucket" "media" {
  bucket_prefix = "${local.name}-media-"
}

resource "aws_s3_bucket" "staff" {
  bucket_prefix = "${local.name}-staff-"
}

resource "aws_s3_bucket" "inspector" {
  bucket_prefix = "${local.name}-inspector-"
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each = {
    media     = aws_s3_bucket.media.id
    staff     = aws_s3_bucket.staff.id
    inspector = aws_s3_bucket.inspector.id
  }

  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "all" {
  for_each = {
    media     = aws_s3_bucket.media.id
    staff     = aws_s3_bucket.staff.id
    inspector = aws_s3_bucket.inspector.id
  }

  bucket = each.value

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_ecr_repository" "api" {
  name                 = local.api_ecr_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "certificate_engine" {
  name                 = local.certificate_engine_ecr_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "beat" {
  name              = "/ecs/${local.name}/beat"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "certificate_engine" {
  name              = "/ecs/${local.name}/certificate-engine"
  retention_in_days = 14
}

resource "aws_secretsmanager_secret" "app" {
  name_prefix = "${local.name}-app-"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL              = "postgresql+asyncpg://${var.db_username}:${urlencode(random_password.db.result)}@${aws_db_instance.postgres.address}:5432/${var.db_name}"
    AUTH_BEARER_HMAC_SECRET   = random_password.auth_hmac.result
    AUTH_MFA_ENCRYPTION_KEY   = random_password.auth_mfa.result
    AUTH_MFA_ENCRYPTION_KEYS  = jsonencode({ (tostring(var.auth_mfa_key_version)) = random_password.auth_mfa.result })
    AUTH_RECOVERY_CODE_PEPPER = random_password.auth_recovery_pepper.result
  })
}

resource "random_password" "notification_webhook" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "notifications" {
  name_prefix = "${local.name}-notifications-"
}

resource "aws_secretsmanager_secret_version" "notifications" {
  secret_id = aws_secretsmanager_secret.notifications.id
  secret_string = jsonencode({
    SMTP_USERNAME               = var.notification_smtp_username
    SMTP_PASSWORD               = var.notification_smtp_password
    TWILIO_ACCOUNT_SID          = var.notification_twilio_account_sid
    TWILIO_AUTH_TOKEN           = var.notification_twilio_auth_token
    TWILIO_FROM                 = var.notification_twilio_from
    NOTIFICATION_WEBHOOK_SECRET = random_password.notification_webhook.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_sns_topic" "notification_events" {
  name = "${local.name}-notification-events"
}

resource "aws_sqs_queue" "notification_events" {
  name                      = "${local.name}-notification-events"
  message_retention_seconds = 1209600
}

data "aws_iam_policy_document" "notification_events_queue" {
  statement {
    sid     = "AllowSnsSendMessage"
    effect  = "Allow"
    actions = ["SQS:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    resources = [aws_sqs_queue.notification_events.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.notification_events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "notification_events" {
  queue_url = aws_sqs_queue.notification_events.id
  policy    = data.aws_iam_policy_document.notification_events_queue.json
}

resource "aws_sns_topic_subscription" "notification_events_queue" {
  topic_arn            = aws_sns_topic.notification_events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.notification_events.arn
  raw_message_delivery = true
}

data "aws_iam_policy_document" "ses_publish_notification_events" {
  statement {
    sid     = "AllowSesPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    resources = [aws_sns_topic.notification_events.arn]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "notification_events" {
  arn    = aws_sns_topic.notification_events.arn
  policy = data.aws_iam_policy_document.ses_publish_notification_events.json
}

resource "aws_sesv2_configuration_set" "notifications" {
  configuration_set_name = local.notification_ses_configuration_set_name
}

resource "aws_sesv2_configuration_set_event_destination" "notification_events" {
  configuration_set_name = aws_sesv2_configuration_set.notifications.configuration_set_name
  event_destination_name = "${local.name}-notification-events"

  event_destination {
    enabled = true
    matching_event_types = [
      "BOUNCE",
      "COMPLAINT",
      "DELIVERY",
      "DELIVERY_DELAY",
      "REJECT",
      "RENDERING_FAILURE",
      "SEND",
    ]

    sns_destination {
      topic_arn = aws_sns_topic.notification_events.arn
    }
  }
}

resource "aws_sesv2_email_identity" "notification_from" {
  count          = var.notification_create_ses_email_identity ? 1 : 0
  email_identity = var.notification_email_from_address
}

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "${local.name}-ecs-execution-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          aws_secretsmanager_secret.app.arn,
          aws_secretsmanager_secret.notifications.arn,
        ]
      }
    ]
  })
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_task_media" {
  name = "${local.name}-ecs-task-media"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ]
        Resource = "${aws_s3_bucket.media.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
        ]
        Resource = aws_s3_bucket.media.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_task_notifications" {
  name = "${local.name}-ecs-task-notifications"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${local.name}.local"
  description = "Private service discovery namespace for HMS ${var.environment}"
  vpc         = aws_vpc.this.id
}

resource "aws_service_discovery_service" "certificate_engine" {
  name = "certificate-engine"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

}

resource "aws_lb" "api" {
  name               = "${local.name}-api"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in aws_subnet.public : subnet.id]
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 8000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "api_http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.backend_image
      essential = true
      command = [
        "uvicorn",
        "hms_backend.app.main:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8000",
      ]
      portMappings = [
        {
          containerPort = 8000
          hostPort      = 8000
          protocol      = "tcp"
        }
      ]
      environment = local.backend_environment
      secrets     = local.backend_secret_environment
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "api"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = local.backend_image
      essential = true
      command = [
        "sh",
        "-c",
        "alembic upgrade head && python -m hms_backend.app.tooling.local_seed && python -m hms_backend.app.tooling.local_seed --auth-test-accounts",
      ]
      environment = local.backend_environment
      secrets     = local.backend_secret_environment
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migrate"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = local.backend_image
      essential = true
      command = [
        "celery",
        "-A",
        "hms_backend.app.core.celery_app:celery_app",
        "worker",
        "--loglevel=info",
      ]
      environment = local.backend_environment
      secrets     = local.backend_secret_environment
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "beat" {
  family                   = "${local.name}-beat"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "beat"
      image     = local.backend_image
      essential = true
      command = [
        "celery",
        "-A",
        "hms_backend.app.core.celery_app:celery_app",
        "beat",
        "--loglevel=info",
      ]
      environment = local.backend_environment
      secrets     = local.backend_secret_environment
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.beat.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "beat"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "certificate_engine" {
  family                   = "${local.name}-certificate-engine"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "certificate-engine"
      image     = local.certificate_engine_image
      essential = true
      portMappings = [
        {
          containerPort = 50051
          hostPort      = 50051
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.certificate_engine.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "certificate-engine"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "certificate_engine" {
  name            = "${local.name}-certificate-engine"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.certificate_engine.arn
  desired_count   = var.certificate_engine_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for subnet in aws_subnet.public : subnet.id]
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.certificate_engine.arn
  }
}

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for subnet in aws_subnet.public : subnet.id]
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }

  depends_on = [
    aws_lb_listener.api_http,
    aws_ecs_service.certificate_engine,
  ]
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for subnet in aws_subnet.public : subnet.id]
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  depends_on = [aws_ecs_service.certificate_engine]
}

resource "aws_ecs_service" "beat" {
  name            = "${local.name}-beat"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.beat.arn
  desired_count   = var.beat_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for subnet in aws_subnet.public : subnet.id]
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }
}

resource "aws_cloudfront_origin_access_control" "staff" {
  name                              = "${local.name}-staff"
  description                       = "OAC for the HMS staff app"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "inspector" {
  name                              = "${local.name}-inspector"
  description                       = "OAC for the HMS inspector app"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${local.name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite frontend application routes to index.html without masking API errors"
  publish = true
  code    = <<-EOT
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.startsWith('/api/') || uri.startsWith('/health')) {
    return request;
  }

  if (uri.includes('.')) {
    return request;
  }

  request.uri = '/index.html';
  return request;
}
EOT
}

resource "aws_cloudfront_distribution" "staff" {
  enabled             = true
  comment             = "${local.name} staff app"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  wait_for_deployment = false

  origin {
    origin_id                = local.cloudfront_staff_origin_id
    domain_name              = aws_s3_bucket.staff.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.staff.id
  }

  origin {
    origin_id   = local.cloudfront_api_origin_id
    domain_name = aws_lb.api.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = local.cloudfront_staff_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.cloudfront_api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "If-Match", "Origin"]
      cookies {
        forward = "all"
      }
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/health*"
    target_origin_id       = local.cloudfront_api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_cloudfront_distribution" "inspector" {
  enabled             = true
  comment             = "${local.name} inspector app"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  wait_for_deployment = false

  origin {
    origin_id                = local.cloudfront_inspector_origin_id
    domain_name              = aws_s3_bucket.inspector.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.inspector.id
  }

  origin {
    origin_id   = local.cloudfront_api_origin_id
    domain_name = aws_lb.api.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = local.cloudfront_inspector_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.cloudfront_api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "If-Match", "X-HMS-Roles", "X-HMS-User-Id"]
      cookies {
        forward = "all"
      }
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/health*"
    target_origin_id       = local.cloudfront_api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "staff" {
  bucket = aws_s3_bucket.staff.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.staff.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.staff.arn
          }
        }
      }
    ]
  })
}

resource "aws_s3_bucket_policy" "inspector" {
  bucket = aws_s3_bucket.inspector.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.inspector.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.inspector.arn
          }
        }
      }
    ]
  })
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_actions.certificates[0].sha1_fingerprint]
}

resource "aws_iam_role" "github_actions_deploy" {
  name = "${local.name}-github-actions-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github_actions.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = var.github_deploy_refs
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name = "${local.name}-github-actions-deploy"
  role = aws_iam_role.github_actions_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = [
          aws_ecr_repository.api.arn,
          aws_ecr_repository.certificate_engine.arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ecs:DescribeClusters",
          "ecs:DescribeServices",
          "ecs:DescribeTasks",
          "ecs:RunTask",
          "ecs:UpdateService",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "iam:PassRole",
        ]
        Resource = [
          aws_iam_role.ecs_task_execution.arn,
          aws_iam_role.ecs_task.arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject",
        ]
        Resource = [
          aws_s3_bucket.staff.arn,
          "${aws_s3_bucket.staff.arn}/*",
          aws_s3_bucket.inspector.arn,
          "${aws_s3_bucket.inspector.arn}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
        ]
        Resource = [
          aws_cloudfront_distribution.staff.arn,
          aws_cloudfront_distribution.inspector.arn,
        ]
      }
    ]
  })
}
