# Minimal operational alarms for the dev API. Alarms only change state: there are no
# alarm/OK actions, so nothing is paged or emailed until an operations destination is
# chosen and wired deliberately. They must not use the notification_events SNS topic,
# which feeds the application's notification pipeline.
#
# Worker and beat are intentionally scaled to zero in dev, so there is no alarm on
# their task counts.

locals {
  alarm_prefix    = local.name
  alarm_namespace = "${local.name}/Api"

  # Free-space floor: the larger of 2 GiB and 10% of the configured storage, so the
  # threshold follows var.db_allocated_storage_gb instead of the current 20 GB.
  db_free_storage_threshold_bytes = max(
    2 * 1024 * 1024 * 1024,
    var.db_allocated_storage_gb * 1024 * 1024 * 1024 * 0.1
  )
}

# The request-failed event is written by the API's structured request log
# (core/observability.py). The migrate task shares this log group but never emits it.
resource "aws_cloudwatch_log_metric_filter" "api_request_failed" {
  name           = "${local.alarm_prefix}-api-request-failed"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.event = \"request.failed\" }"

  metric_transformation {
    name          = "RequestFailed"
    namespace     = local.alarm_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_request_failed" {
  alarm_name          = "${local.alarm_prefix}-api-request-failed"
  alarm_description   = "At least one unhandled API exception (request.failed) in 5 minutes."
  namespace           = local.alarm_namespace
  metric_name         = "RequestFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  depends_on = [aws_cloudwatch_log_metric_filter.api_request_failed]
}

# Missing data counts as breaching: if the target metrics disappear the API must not
# silently look healthy.
resource "aws_cloudwatch_metric_alarm" "api_healthy_hosts" {
  alarm_name          = "${local.alarm_prefix}-api-no-healthy-hosts"
  alarm_description   = "The API target group has had no healthy targets for 3 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    LoadBalancer = aws_lb.api.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "api_target_5xx" {
  alarm_name          = "${local.alarm_prefix}-api-target-5xx"
  alarm_description   = "Five or more 5xx responses from the API targets in 5 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.api.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
}

# Sustained, not spiky: all three consecutive 5-minute averages must be at or above 80%.
resource "aws_cloudwatch_metric_alarm" "api_cpu_high" {
  alarm_name          = "${local.alarm_prefix}-api-cpu-high"
  alarm_description   = "API service CPU at or above 80% for 15 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.api.name
  }
}

resource "aws_cloudwatch_metric_alarm" "api_memory_high" {
  alarm_name          = "${local.alarm_prefix}-api-memory-high"
  alarm_description   = "API service memory at or above 80% for 15 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.api.name
  }
}

resource "aws_cloudwatch_metric_alarm" "db_free_storage_low" {
  alarm_name          = "${local.alarm_prefix}-db-free-storage-low"
  alarm_description   = "RDS free storage below max(2 GiB, 10% of allocated storage)."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = local.db_free_storage_threshold_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.identifier
  }
}
