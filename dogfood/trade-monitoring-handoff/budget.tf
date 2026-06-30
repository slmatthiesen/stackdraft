##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# REFERENCE-ONLY Terraform for the BUDGET tier — generated
# DETERMINISTICALLY from the design graph. Human review + hardening required.
# =============================================================================

# =============================================================================
# PROVIDERS & VARIABLES
# =============================================================================

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ACM certs and WAF web ACLs for CloudFront MUST live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "domain_name" {
  type        = string
  description = "Primary domain served by CloudFront, e.g. example.com."
}

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted-zone id for domain_name (ACM DNS validation + alias records)."
}

# A CloudFront https-only origin must present a trusted-CA cert for its hostname.
# NEVER an EC2 instance public DNS / raw ALB DNS name (no cert, churns on replace)
# — supply a custom domain (ALB or EIP + Route53) with an ACM cert. (rule:
# cloudfront-origin-tls)
variable "origin_domain" {
  type        = string
  description = "Custom domain (ALB / EIP + Route53) for the dynamic origin — MUST have a TLS cert."
}

variable "ops_email" {
  type        = string
  description = "Destination for SNS ops alerts."
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = var.aws_region
}

# =============================================================================
# KMS KEYS
# =============================================================================

# General-purpose CMK — S3 buckets, EBS volumes, Secrets Manager.
resource "aws_kms_key" "main" {
  description             = "budget main CMK — S3, EBS, Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "kms:*"
        Resource = "*"
      },
      {
        Sid = "AllowSecretsManager"
        Effect = "Allow"
        Principal = {
          Service = "secretsmanager.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:CreateGrant",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/budget-main"
  target_key_id = aws_kms_key.main.key_id
}

# CloudWatch Logs CMK — the Logs service principal MUST be granted, keyed off
# the LITERAL region (not ${local.region}), or PutLogEvents fails at runtime.
resource "aws_kms_key" "cw_logs" {
  description             = "budget CloudWatch Logs CMK"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "kms:*"
        Resource = "*"
      },
      {
        Sid = "AllowCloudWatchLogs"
        Effect = "Allow"
        Principal = {
          Service = "logs.us-east-1.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:us-east-1:${local.account_id}:*"
          }
        }
      }
    ]
  })
}

resource "aws_kms_alias" "cw_logs" {
  name          = "alias/budget-cw-logs"
  target_key_id = aws_kms_key.cw_logs.key_id
}

# SNS CMK — a CloudWatch alarm publishing to an encrypted topic needs BOTH the
# cloudwatch and sns service principals, or alarm publish fails at runtime.
resource "aws_kms_key" "sns" {
  description             = "budget SNS ops-alert CMK"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "kms:*"
        Resource = "*"
      },
      {
        Sid = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = "*"
      },
      {
        Sid = "AllowSNSService"
        Effect = "Allow"
        Principal = {
          Service = "sns.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "sns" {
  name          = "alias/budget-sns"
  target_key_id = aws_kms_key.sns.key_id
}

# =============================================================================
# IAM
# =============================================================================

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# =============================================================================
# IAM — HTTP DISPATCHER TO FRONTEND
# =============================================================================

resource "aws_iam_role" "dispatch_lambda" {
  name               = "budget-dispatch-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "dispatch_lambda_managed" {
  role       = aws_iam_role.dispatch_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# =============================================================================
# IAM — STREAMS → S3 DATA LAKE STUB
# =============================================================================

resource "aws_iam_role" "streams_lambda" {
  name               = "budget-streams-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "streams_lambda_managed" {
  role       = aws_iam_role.streams_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "streams_lambda_inline" {
  name = "budget-streams-lambda-inline"
  role = aws_iam_role.streams_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "S3_s3_datalake"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.s3_datalake.arn,
          "${aws_s3_bucket.s3_datalake.arn}/*"
        ]
      },
      {
        Sid = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# =============================================================================
# IAM — TOKEN VERIFY + PERSIST
# =============================================================================

resource "aws_iam_role" "ingest_lambda" {
  name               = "budget-ingest-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ingest_lambda_managed" {
  role       = aws_iam_role.ingest_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ingest_lambda_inline" {
  name = "budget-ingest-lambda-inline"
  role = aws_iam_role.ingest_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "Secret_secrets"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.secrets.arn
      },
      {
        Sid = "Dynamo_dynamo"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem"
        ]
        Resource = [
          aws_dynamodb_table.dynamo.arn,
          "${aws_dynamodb_table.dynamo.arn}/index/*"
        ]
      },
      {
        Sid = "SendMessage_sqs_fanout"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl"
        ]
        Resource = aws_sqs_queue.sqs_fanout.arn
      },
      {
        Sid = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# =============================================================================
# S3 — RAW TRADE SIGNAL ARCHIVE
# =============================================================================

resource "aws_s3_bucket" "s3_datalake" {
  bucket_prefix = "budget-s3-datalake-"
  force_destroy = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "s3_datalake" {
  bucket = aws_s3_bucket.s3_datalake.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "s3_datalake" {
  bucket                  = aws_s3_bucket.s3_datalake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "s3_datalake" {
  bucket = aws_s3_bucket.s3_datalake.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_policy" "s3_datalake" {
  bucket = aws_s3_bucket.s3_datalake.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action = "s3:*"
        Resource = [
          aws_s3_bucket.s3_datalake.arn,
          "${aws_s3_bucket.s3_datalake.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# =============================================================================
# SECRETS MANAGER — WEBHOOK SECRET STORE
# =============================================================================

# No rotation Lambda is provided, so the rotation resource is intentionally
# OMITTED — a null rotation_lambda_arn is invalid (rule: secretsmanager-rotation-lambda).
resource "aws_secretsmanager_secret" "secrets" {
  name       = "budget/secrets"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "secrets" {
  secret_id     = aws_secretsmanager_secret.secrets.id
  secret_string = jsonencode({
    username = "REPLACE_ME"
    password = "REPLACE_ME" # inject out-of-band; do not commit a real secret
  })
}

# =============================================================================
# LAMBDA — HTTP DISPATCHER TO FRONTEND
# =============================================================================

resource "aws_lambda_function" "dispatch_lambda" {
  function_name = "budget-dispatch-lambda"
  role          = aws_iam_role.dispatch_lambda.arn
  # Placeholder package — replace with your real deployment artifact.
  filename      = "dispatch_lambda_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300

  tracing_config {
    mode = "Active"
  }
  # No vpc_config — a non-VPC Lambda reaches public AWS endpoints directly
  # (Secrets Manager, S3) with no NAT, the cost-honest default.
}

resource "aws_cloudwatch_log_group" "dispatch_lambda" {
  name              = "/aws/lambda/budget-dispatch-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# LAMBDA — STREAMS → S3 DATA LAKE STUB
# =============================================================================

resource "aws_lambda_function" "streams_lambda" {
  function_name = "budget-streams-lambda"
  role          = aws_iam_role.streams_lambda.arn
  # Placeholder package — replace with your real deployment artifact.
  filename      = "streams_lambda_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300

  tracing_config {
    mode = "Active"
  }
  # No vpc_config — a non-VPC Lambda reaches public AWS endpoints directly
  # (Secrets Manager, S3) with no NAT, the cost-honest default.
}

resource "aws_cloudwatch_log_group" "streams_lambda" {
  name              = "/aws/lambda/budget-streams-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# LAMBDA — TOKEN VERIFY + PERSIST
# =============================================================================

resource "aws_lambda_function" "ingest_lambda" {
  function_name = "budget-ingest-lambda"
  role          = aws_iam_role.ingest_lambda.arn
  # Placeholder package — replace with your real deployment artifact.
  filename      = "ingest_lambda_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300
  reserved_concurrent_executions = 10

  tracing_config {
    mode = "Active"
  }
  # No vpc_config — a non-VPC Lambda reaches public AWS endpoints directly
  # (Secrets Manager, S3) with no NAT, the cost-honest default.
}

resource "aws_cloudwatch_log_group" "ingest_lambda" {
  name              = "/aws/lambda/budget-ingest-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# SNS — OPS ALERT TOPIC
# =============================================================================

resource "aws_sns_topic" "sns_alert" {
  name              = "budget-sns-alert"
  kms_master_key_id = aws_kms_key.sns.arn
}

resource "aws_sns_topic_policy" "sns_alert" {
  arn    = aws_sns_topic.sns_alert.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "AllowAccountPublish"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "sns:Publish"
        Resource = aws_sns_topic.sns_alert.arn
      },
      {
        Sid = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action = "sns:Publish"
        Resource = aws_sns_topic.sns_alert.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
        }
      },
      {
        Sid = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action = "sns:Publish"
        Resource = aws_sns_topic.sns_alert.arn
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

resource "aws_sns_topic_subscription" "sns_alert_email" {
  topic_arn = aws_sns_topic.sns_alert.arn
  protocol  = "email"
  endpoint  = var.ops_email
}

# =============================================================================
# CLOUDWATCH LOGS
# =============================================================================

resource "aws_cloudwatch_log_group" "cw_logs" {
  name              = "/budget/app"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# CLOUDWATCH ALARMS
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "ingest_lambda_errors" {
  alarm_name          = "budget-ingest-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_actions       = [aws_sns_topic.sns_alert.arn]
  dimensions          = { FunctionName = aws_lambda_function.ingest_lambda.function_name }
}

resource "aws_cloudwatch_metric_alarm" "dispatch_lambda_errors" {
  alarm_name          = "budget-dispatch-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_actions       = [aws_sns_topic.sns_alert.arn]
  dimensions          = { FunctionName = aws_lambda_function.dispatch_lambda.function_name }
}

resource "aws_cloudwatch_metric_alarm" "streams_lambda_errors" {
  alarm_name          = "budget-streams-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_actions       = [aws_sns_topic.sns_alert.arn]
  dimensions          = { FunctionName = aws_lambda_function.streams_lambda.function_name }
}

# =============================================================================
# CLOUDFRONT
# =============================================================================

resource "aws_wafv2_web_acl" "cf_waf" {
  provider    = aws.us_east_1
  name        = "budget-cf-waf"
  scope       = "CLOUDFRONT"
  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimit"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "budget-cf-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_acm_certificate" "cf_waf" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cf_waf_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cf_waf.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  allow_overwrite = true
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
}

resource "aws_acm_certificate_validation" "cf_waf" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cf_waf.arn
  validation_record_fqdns = [for r in aws_route53_record.cf_waf_cert_validation : r.fqdn]
}

data "aws_canonical_user_id" "current" {}
data "aws_cloudfront_log_delivery_canonical_user_id" "current" {}

resource "aws_s3_bucket" "cf_waf_logs" {
  bucket_prefix = "budget-cf-logs-"
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "cf_waf_logs" {
  bucket = aws_s3_bucket.cf_waf_logs.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_bucket_public_access_block" "cf_waf_logs" {
  bucket                  = aws_s3_bucket.cf_waf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront delivers access logs as the awslogsdelivery CanonicalUser; grant it
# FULL_CONTROL or logging silently no-ops under Block Public Access.
resource "aws_s3_bucket_acl" "cf_waf_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.cf_waf_logs]
  bucket     = aws_s3_bucket.cf_waf_logs.id
  access_control_policy {
    owner { id = data.aws_canonical_user_id.current.id }
    grant {
      grantee {
        id   = data.aws_cloudfront_log_delivery_canonical_user_id.current.id
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }
    grant {
      grantee {
        id   = data.aws_canonical_user_id.current.id
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }
  }
}

resource "aws_cloudfront_distribution" "cf_waf" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.cf_waf.arn
  aliases             = [var.domain_name]

  # API Gateway (HTTP API) origin over a custom domain with a TLS cert (NOT a raw AWS DNS name — rule cloudfront-origin-tls).
  origin {
    domain_name = var.origin_domain
    origin_id   = "origin-apigw"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "origin-apigw"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    forwarded_values {
      query_string = true
      cookies { forward = "all" }
    }
    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf_waf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  logging_config {
    bucket          = aws_s3_bucket.cf_waf_logs.bucket_domain_name
    prefix          = "cf-logs/"
    include_cookies = false
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
}

resource "aws_route53_record" "cf_waf_alias" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.cf_waf.domain_name
    zone_id                = aws_cloudfront_distribution.cf_waf.hosted_zone_id
    evaluate_target_health = false
  }
}

# =============================================================================
# CLOUDTRAIL
# =============================================================================

resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket_prefix = "budget-cloudtrail-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "cloudtrail_logs" {
  bucket                  = aws_s3_bucket.cloudtrail_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "cloudtrail_logs" {
  bucket = aws_s3_bucket.cloudtrail_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "AWSCloudTrailAclCheck"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action = "s3:GetBucketAcl"
        Resource = aws_s3_bucket.cloudtrail_logs.arn
      },
      {
        Sid = "AWSCloudTrailWrite"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action = "s3:PutObject"
        Resource = "${aws_s3_bucket.cloudtrail_logs.arn}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
          }
        }
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/aws/cloudtrail/budget"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cw_logs.arn
}

data "aws_iam_policy_document" "cloudtrail_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail_cw" {
  name               = "budget-cloudtrail-cw"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_assume.json
}

resource "aws_iam_role_policy" "cloudtrail_cw" {
  name = "cloudtrail-cw"
  role = aws_iam_role.cloudtrail_cw.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
      }
    ]
  })
}

resource "aws_cloudtrail" "cloudtrail" {
  name                          = "budget-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.bucket
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  include_global_service_events = true
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail_cw.arn
  depends_on                    = [aws_s3_bucket_policy.cloudtrail_logs]
}

# =============================================================================
# API GATEWAY — INGEST HTTP ENDPOINT
# =============================================================================

resource "aws_apigatewayv2_api" "apigw" {
  name          = "budget-apigw"
  protocol_type = "HTTP"
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigw/budget-apigw"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

resource "aws_apigatewayv2_stage" "apigw" {
  api_id      = aws_apigatewayv2_api.apigw.id
  name        = "$default"
  auto_deploy = true
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId    = "$context.requestId"
      routeKey     = "$context.routeKey"
      status       = "$context.status"
      responseTime = "$context.responseLatency"
    })
  }
}

resource "aws_apigatewayv2_integration" "apigw_ingest_lambda" {
  api_id                 = aws_apigatewayv2_api.apigw.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingest_lambda.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "apigw_ingest_lambda" {
  api_id    = aws_apigatewayv2_api.apigw.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.apigw_ingest_lambda.id}"
}

resource "aws_lambda_permission" "apigw_ingest_lambda" {
  statement_id  = "AllowAPIGWInvoke_ingest_lambda"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest_lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.apigw.execution_arn}/*/*"
}

# =============================================================================
# DYNAMODB — CANONICAL TRADE STORE (ON-DEMAND)
# =============================================================================

resource "aws_dynamodb_table" "dynamo" {
  name         = "budget-dynamo"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.main.arn
  }
  point_in_time_recovery {
    enabled = true
  }
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"
}

resource "aws_lambda_event_source_mapping" "dynamo_streams_lambda" {
  event_source_arn  = aws_dynamodb_table.dynamo.stream_arn
  function_name     = aws_lambda_function.streams_lambda.arn
  starting_position = "LATEST"
  batch_size        = 100
}

resource "aws_iam_role_policy" "streams_lambda_stream_dynamo" {
  name = "budget-streams-lambda-stream-dynamo"
  role = aws_iam_role.streams_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "ReadStream"
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams"
        ]
        Resource = "${aws_dynamodb_table.dynamo.arn}/stream/*"
      }
    ]
  })
}

# =============================================================================
# SQS — FAN-OUT DEAD-LETTER QUEUE
# =============================================================================

resource "aws_sqs_queue" "sqs_dlq" {
  name                       = "budget-sqs-dlq"
  sqs_managed_sse_enabled    = true
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 300
}

# =============================================================================
# SQS — FAN-OUT DELIVERY QUEUE
# =============================================================================

resource "aws_sqs_queue" "sqs_fanout" {
  name                       = "budget-sqs-fanout"
  sqs_managed_sse_enabled    = true
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 300
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sqs_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_lambda_event_source_mapping" "sqs_fanout_dispatch_lambda" {
  event_source_arn = aws_sqs_queue.sqs_fanout.arn
  function_name    = aws_lambda_function.dispatch_lambda.arn
  batch_size       = 10
}

resource "aws_iam_role_policy" "dispatch_lambda_consume_sqs_fanout" {
  name = "budget-dispatch-lambda-consume-sqs-fanout"
  role = aws_iam_role.dispatch_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "ConsumeQueue"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.sqs_fanout.arn
      }
    ]
  })
}
