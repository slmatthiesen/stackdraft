##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# BUDGET TIER — REFERENCE-ONLY TERRAFORM
# Review and harden before any production use.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"
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

# CloudFront ACM certificates must be in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# =============================================================================
# VARIABLES
# =============================================================================

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Primary AWS region."
}

variable "project" {
  type        = string
  default     = "drafture"
  description = "Project name used as a prefix for all resources (and the SSM key path / container name)."
}

variable "ops_email" {
  type        = string
  description = "Email address to receive ops alerts via SNS."
}

variable "ami_id" {
  type        = string
  default     = ""
  description = "ARM64 AMI for t4g.small. Leave empty to auto-resolve the latest Amazon Linux 2023 arm64 AMI (recommended); set an explicit ID to pin one."
}

variable "container_image" {
  type        = string
  description = "Container image URI for the app, e.g. <acct>.dkr.ecr.<region>.amazonaws.com/drafture:latest. Build + push your image and set this before apply — there is no default on purpose."
}

variable "container_port" {
  type        = number
  default     = 8080
  description = "Port the app container listens on (Fastify serves the SPA + /api on one port)."
}

variable "enable_langfuse" {
  type        = bool
  default     = false
  description = "Create SSM SecureString placeholders for Langfuse LLM-observability keys (set the real values out-of-band, like the Anthropic key). Leave false to run without tracing — the app degrades to disabled cleanly."
}

variable "langfuse_base_url" {
  type        = string
  default     = "https://cloud.langfuse.com"
  description = "Langfuse API base URL. EU cloud default; US = https://us.cloud.langfuse.com; or your self-hosted URL. Only used when the Langfuse keys are set."
}

variable "vpc_id" {
  type        = string
  description = "Existing VPC ID to deploy into."
}

variable "public_subnet_id" {
  type        = string
  description = "Public subnet ID for the EC2 instance."
}

variable "cloudflare_ipv4_cidrs" {
  type        = list(string)
  description = "Cloudflare IPv4 ranges — keep updated from https://www.cloudflare.com/ips/"
  default = [
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "108.162.192.0/18",
    "131.0.72.0/22",
    "141.101.64.0/18",
    "162.158.0.0/15",
    "172.64.0.0/13",
    "173.245.48.0/20",
    "188.114.96.0/20",
    "190.93.240.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
  ]
}

variable "cloudflare_ipv6_cidrs" {
  type        = list(string)
  description = "Cloudflare IPv6 ranges — keep updated from https://www.cloudflare.com/ips/"
  default = [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ]
}

variable "static_site_domain" {
  type        = string
  description = "Domain name served by CloudFront (e.g. app.example.com)."
}

variable "ebs_volume_size_gb" {
  type        = number
  default     = 20
  description = "EBS gp3 volume size in GB for SQLite."
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "CloudWatch Logs retention in days."
}

variable "snapshot_retention_days" {
  type        = number
  default     = 7
  description = "Number of days to retain automated EBS snapshots."
}

variable "backup_lifecycle_days" {
  type        = number
  default     = 30
  description = "S3 backup bucket lifecycle expiration in days."
}

# =============================================================================
# DATA SOURCES
# =============================================================================

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Latest Amazon Linux 2023 arm64 AMI — used when var.ami_id is empty so a first
# apply doesn't fail hunting a region-specific AMI ID by hand.
data "aws_ami" "al2023_arm64" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-arm64"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# =============================================================================
# KMS — EBS ENCRYPTION KEY
# =============================================================================

resource "aws_kms_key" "ebs" {
  description             = "${var.project} EBS encryption key"
  deletion_window_in_days = 14
  enable_key_rotation     = true

  tags = {
    Project = var.project
    Purpose = "ebs-encryption"
  }
}

resource "aws_kms_alias" "ebs" {
  name          = "alias/${var.project}-ebs"
  target_key_id = aws_kms_key.ebs.key_id
}

# KMS key for CloudWatch Logs encryption
resource "aws_kms_key" "logs" {
  description             = "${var.project} CloudWatch Logs encryption key"
  deletion_window_in_days = 14
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountRoot"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowCloudWatchLogs"
        Effect = "Allow"
        Principal = {
          Service = "logs.${data.aws_region.current.name}.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"
          }
        }
      },
    ]
  })

  tags = {
    Project = var.project
    Purpose = "logs-encryption"
  }
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.project}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

# =============================================================================
# S3 — STATIC SITE ASSETS (CloudFront OAC origin)
# =============================================================================

resource "aws_s3_bucket" "static" {
  bucket        = "${var.project}-static-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    Project = var.project
    Purpose = "static-assets"
  }
}

resource "aws_s3_bucket_versioning" "static" {
  bucket = aws_s3_bucket.static.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "static" {
  bucket = aws_s3_bucket.static.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "static" {
  bucket                  = aws_s3_bucket.static.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "static" {
  bucket = aws_s3_bucket.static.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# OAC bucket policy — only CloudFront can read
resource "aws_s3_bucket_policy" "static" {
  bucket = aws_s3_bucket.static.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.static.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.spa.arn
          }
        }
      },
    ]
  })
}

# =============================================================================
# S3 — BACKUP / SNAPSHOT EXPORT BUCKET
# =============================================================================

resource "aws_s3_bucket" "backup" {
  bucket        = "${var.project}-backup-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    Project = var.project
    Purpose = "backup-snapshots"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"

    # Empty filter = apply to all objects. Required by AWS provider v5 (a rule with
    # neither filter nor prefix is a validation error in newer versions).
    filter {}

    expiration {
      days = var.backup_lifecycle_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.backup_lifecycle_days
    }
  }
}

# =============================================================================
# S3 — CLOUDTRAIL DELIVERY BUCKET
# =============================================================================

resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "${var.project}-cloudtrail-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    Project = var.project
    Purpose = "cloudtrail-audit"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AWSCloudTrailAclCheck"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action   = "s3:GetBucketAcl"
        Resource = aws_s3_bucket.cloudtrail.arn
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudtrail:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:trail/${var.project}-trail"
          }
        }
      },
      {
        Sid    = "AWSCloudTrailWrite"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "AWS:SourceArn" = "arn:aws:cloudtrail:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:trail/${var.project}-trail"
          }
        }
      },
    ]
  })
}

# =============================================================================
# CLOUDTRAIL
# =============================================================================

resource "aws_cloudtrail" "main" {
  name                          = "${var.project}-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  tags = {
    Project = var.project
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail]
}

# =============================================================================
# SNS — OPS ALERTS
# =============================================================================

resource "aws_sns_topic" "ops" {
  name              = "${var.project}-ops-alerts"
  kms_master_key_id = "alias/aws/sns"

  tags = {
    Project = var.project
  }
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.ops_email
}

# SNS topic policy — restrict publish to CloudWatch Alarms and this account
resource "aws_sns_topic_policy" "ops" {
  arn = aws_sns_topic.ops.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountPublish"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "SNS:Publish"
        Resource = aws_sns_topic.ops.arn
      },
      {
        Sid    = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action   = "SNS:Publish"
        Resource = aws_sns_topic.ops.arn
        Condition = {
          StringEquals = {
            "AWS:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
    ]
  })
}

# =============================================================================
# CLOUDWATCH LOGS
# =============================================================================

resource "aws_cloudwatch_log_group" "app" {
  name              = "/app/${var.project}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = {
    Project = var.project
  }
}

resource "aws_cloudwatch_log_metric_filter" "error_rate" {
  name           = "${var.project}-error-filter"
  pattern        = "{ $.level = \"error\" }"
  log_group_name = aws_cloudwatch_log_group.app.name

  metric_transformation {
    name          = "ErrorCount"
    namespace     = "${var.project}/App"
    value         = "1"
    default_value = "0"
  }
}

# =============================================================================
# CLOUDWATCH ALARMS
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "${var.project}-high-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ErrorCount"
  namespace           = "${var.project}/App"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "High application error rate detected."
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Project = var.project
  }
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${var.project}-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  alarm_description   = "EC2 CPU utilization above 85%."
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
  treat_missing_data  = "missing"

  dimensions = {
    InstanceId = aws_instance.app.id
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# IAM — EC2 INSTANCE ROLE (LEAST PRIVILEGE)
# =============================================================================

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_app" {
  name               = "${var.project}-ec2-app-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json

  tags = {
    Project = var.project
  }
}

# SSM Session Manager (no SSH)
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2_app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# CloudWatch agent
resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.ec2_app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# Least-priv inline policy
data "aws_iam_policy_document" "ec2_app_inline" {
  # SSM Parameter Store — read SecureStrings under /budget/
  statement {
    sid    = "SSMReadSecrets"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/${var.project}/*"
    ]
  }

  # KMS decrypt for SSM SecureString
  statement {
    sid    = "KMSDecryptSSM"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.ebs.arn]
  }

  # S3 backup bucket — put objects (batch/pricing upload)
  statement {
    sid    = "S3BackupWrite"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.backup.arn,
      "${aws_s3_bucket.backup.arn}/*",
    ]
  }

  # CloudWatch Logs — write app logs
  statement {
    sid    = "CWLogsWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }

  # EC2 describe for CloudWatch agent instance metadata
  statement {
    sid    = "EC2DescribeSelf"
    effect = "Allow"
    actions = [
      "ec2:DescribeTags",
      "ec2:DescribeInstances",
    ]
    resources = ["*"]
    # TODO: narrow to instance-specific once instance ARN is known
  }
}

resource "aws_iam_role_policy" "ec2_app_inline" {
  name   = "${var.project}-ec2-app-inline"
  role   = aws_iam_role.ec2_app.id
  policy = data.aws_iam_policy_document.ec2_app_inline.json
}

resource "aws_iam_instance_profile" "ec2_app" {
  name = "${var.project}-ec2-app-profile"
  role = aws_iam_role.ec2_app.name
}

# =============================================================================
# SECURITY GROUP — EC2
# Allow only Cloudflare IPs on 80/443; no SSH (SSM only)
# =============================================================================

resource "aws_security_group" "ec2_app" {
  name        = "${var.project}-ec2-app-sg"
  description = "Allow HTTP/HTTPS from Cloudflare IPs only; no SSH"
  vpc_id      = var.vpc_id

  tags = {
    Project = var.project
    Name    = "${var.project}-ec2-app-sg"
  }
}

resource "aws_vpc_security_group_egress_rule" "ec2_all_ipv4" {
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all outbound IPv4 (AWS APIs, OS updates). Tighten per workload."
}

resource "aws_vpc_security_group_egress_rule" "ec2_all_ipv6" {
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv6         = "::/0"
  ip_protocol       = "-1"
  description       = "Allow all outbound IPv6."
}

# Cloudflare IPv4 — HTTP
resource "aws_vpc_security_group_ingress_rule" "cf_http_v4" {
  for_each          = toset(var.cloudflare_ipv4_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv4 HTTP"
}

# Cloudflare IPv4 — HTTPS
resource "aws_vpc_security_group_ingress_rule" "cf_https_v4" {
  for_each          = toset(var.cloudflare_ipv4_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv4 HTTPS"
}

# Cloudflare IPv6 — HTTP
resource "aws_vpc_security_group_ingress_rule" "cf_http_v6" {
  for_each          = toset(var.cloudflare_ipv6_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv6         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv6 HTTP"
}

# Cloudflare IPv6 — HTTPS
resource "aws_vpc_security_group_ingress_rule" "cf_https_v6" {
  for_each          = toset(var.cloudflare_ipv6_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv6         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv6 HTTPS"
}

# =============================================================================
# EBS — gp3 DATA VOLUME (SQLite)
# =============================================================================

resource "aws_ebs_volume" "db" {
  availability_zone = data.aws_availability_zones.available.names[0]
  size              = var.ebs_volume_size_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = aws_kms_key.ebs.arn

  tags = {
    Project = var.project
    Name    = "${var.project}-sqlite-db"
    Backup  = "daily"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

# =============================================================================
# EC2 — t4g.small (ARM64 Fastify API host)
# =============================================================================

resource "aws_instance" "app" {
  ami                         = var.ami_id != "" ? var.ami_id : data.aws_ami.al2023_arm64.id
  instance_type               = "t4g.small"
  subnet_id                   = var.public_subnet_id
  vpc_security_group_ids      = [aws_security_group.ec2_app.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2_app.name
  associate_public_ip_address = true

  # IMDSv2 enforced
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  # Root volume — minimal; data lives on attached EBS
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    kms_key_id            = aws_kms_key.ebs.arn
    delete_on_termination = true
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -euo pipefail

    # Install SSM agent (pre-installed on AL2023; kept for Ubuntu fallback)
    if command -v snap &>/dev/null; then
      snap install amazon-ssm-agent --classic
      systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
    fi

    # Install CloudWatch agent
    if command -v dnf &>/dev/null; then
      dnf install -y amazon-cloudwatch-agent
    else
      wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb
      dpkg -i amazon-cloudwatch-agent.deb
    fi

    # Mount the data EBS volume. On Nitro (t4g) AL2023 the ec2-utils udev rules
    # symlink the attachment (/dev/xvdf, matching aws_volume_attachment.db) to the
    # underlying NVMe device; wait for it, format ONCE (guarded by a blkid check so a
    # reboot never reformats live data), then persist via fstab with nofail.
    DEVICE=/dev/xvdf
    MOUNT=/data
    for i in $(seq 1 30); do [ -e "$DEVICE" ] && break; sleep 2; done
    if ! blkid "$DEVICE"; then
      mkfs.xfs "$DEVICE"
    fi
    mkdir -p "$MOUNT"
    grep -q "$MOUNT" /etc/fstab || echo "$DEVICE $MOUNT xfs defaults,nofail 0 2" >> /etc/fstab
    mount -a

    # CloudWatch agent config — structured JSON logs to log group
    cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'CWCONFIG'
    {
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/log/app/*.json",
                "log_group_name": "/app/${var.project}/api",
                "log_stream_name": "{instance_id}",
                "timezone": "UTC"
              }
            ]
          }
        }
      }
    }
    CWCONFIG

    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config -m ec2 -s \
      -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

    # -----------------------------------------------------------------------
    # Deploy the app container. The image (var.container_image) must be pushed
    # first. The Anthropic key is read from SSM at boot (never baked into the AMI
    # or this file); SQLite lives on the mounted data volume so it survives
    # instance replacement. Cloudflare terminates TLS and proxies to :80 here
    # (set the CF origin to "Full" with an origin cert, or "Flexible"); the
    # container listens on var.container_port.
    # -----------------------------------------------------------------------
    dnf install -y docker
    systemctl enable --now docker

    # If the image is in a private ECR repo, authenticate first:
    #   aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin <acct>.dkr.ecr.${var.aws_region}.amazonaws.com

    APP_KEY="$(aws ssm get-parameter --name /${var.project}/anthropic_api_key --with-decryption --region ${var.aws_region} --query Parameter.Value --output text)"

    # Langfuse LLM-observability keys (OPTIONAL). Tolerant read: if the params don't
    # exist (enable_langfuse=false, or not set), these resolve to empty and the app
    # treats tracing as disabled (both keys are required to enable it) — no failure.
    LF_PK="$(aws ssm get-parameter --name /${var.project}/langfuse_public_key --with-decryption --region ${var.aws_region} --query Parameter.Value --output text 2>/dev/null || true)"
    LF_SK="$(aws ssm get-parameter --name /${var.project}/langfuse_secret_key --with-decryption --region ${var.aws_region} --query Parameter.Value --output text 2>/dev/null || true)"

    # The image declares VOLUME /app/data and defaults DB_PATH=/app/data/drafture.db,
    # so mount the host data volume there and let the image's own default stand.
    docker run -d --name ${var.project} --restart always \
      -p 80:${var.container_port} \
      -v /data:/app/data \
      -e STORE_BACKEND=sqlite \
      -e ANTHROPIC_API_KEY="$APP_KEY" \
      -e LANGFUSE_PUBLIC_KEY="$LF_PK" \
      -e LANGFUSE_SECRET_KEY="$LF_SK" \
      -e LANGFUSE_BASE_URL="${var.langfuse_base_url}" \
      ${var.container_image}
  EOF
  )

  tags = {
    Project = var.project
    Name    = "${var.project}-api-server"
  }

  # Prevent accidental termination — REVIEW before destroying
  lifecycle {
    prevent_destroy = true
  }
}

# Attach EBS data volume
resource "aws_volume_attachment" "db" {
  device_name  = "/dev/xvdf"
  volume_id    = aws_ebs_volume.db.id
  instance_id  = aws_instance.app.id
  force_detach = false
}

# =============================================================================
# EBS SNAPSHOT LIFECYCLE (Daily)
# =============================================================================

resource "aws_iam_role" "dlm" {
  name = "${var.project}-dlm-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "ebs_daily" {
  description        = "${var.project} daily EBS snapshot"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Backup = "daily"
    }

    schedule {
      name = "daily-0200"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["02:00"]
      }

      retain_rule {
        count = var.snapshot_retention_days
      }

      copy_tags = true
    }
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# SSM PARAMETER STORE — API KEY PLACEHOLDERS
# (Actual values must be set out-of-band via AWS CLI / console)
# =============================================================================

resource "aws_ssm_parameter" "anthropic_api_key" {
  name        = "/${var.project}/anthropic_api_key"
  type        = "SecureString"
  value       = "PLACEHOLDER_REPLACE_OUT_OF_BAND"
  description = "Anthropic API key — replace via: aws ssm put-parameter --overwrite"
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Project = var.project
  }
}

# Langfuse LLM-observability keys (OPTIONAL — created only when enable_langfuse=true).
# Placeholders: set the real values out-of-band, same as the Anthropic key:
#   aws ssm put-parameter --overwrite --type SecureString --name /${project}/langfuse_public_key --value pk-lf-...
#   aws ssm put-parameter --overwrite --type SecureString --name /${project}/langfuse_secret_key --value sk-lf-...
resource "aws_ssm_parameter" "langfuse_public_key" {
  count       = var.enable_langfuse ? 1 : 0
  name        = "/${var.project}/langfuse_public_key"
  type        = "SecureString"
  value       = "PLACEHOLDER_REPLACE_OUT_OF_BAND"
  description = "Langfuse public key — replace via: aws ssm put-parameter --overwrite"
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Project = var.project
  }
}

resource "aws_ssm_parameter" "langfuse_secret_key" {
  count       = var.enable_langfuse ? 1 : 0
  name        = "/${var.project}/langfuse_secret_key"
  type        = "SecureString"
  value       = "PLACEHOLDER_REPLACE_OUT_OF_BAND"
  description = "Langfuse secret key — replace via: aws ssm put-parameter --overwrite"
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# WAF — for CloudFront (us-east-1)
# =============================================================================

resource "aws_wafv2_web_acl" "cdn" {
  provider    = aws.us_east_1
  name        = "${var.project}-cdn-waf"
  scope       = "CLOUDFRONT"
  description = "WAF for CloudFront distribution — managed rules."

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

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
      metric_name                = "${var.project}-CRS"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20

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
      metric_name                = "${var.project}-KBI"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-cdn-waf"
    sampled_requests_enabled   = true
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# S3 — CLOUDFRONT ACCESS LOG BUCKET
# =============================================================================

resource "aws_s3_bucket" "cf_logs" {
  provider      = aws.us_east_1
  bucket        = "${var.project}-cf-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    Project = var.project
    Purpose = "cloudfront-access-logs"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cf_logs" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.cf_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  provider                = aws.us_east_1
  bucket                  = aws_s3_bucket.cf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "cf_logs" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.cf_logs.id
  rule {
    # CloudFront standard logging requires ObjectWriter or BucketOwnerPreferred
    object_ownership = "ObjectWriter"
  }
}

resource "aws_s3_bucket_acl" "cf_logs" {
  provider   = aws.us_east_1
  bucket     = aws_s3_bucket.cf_logs.id
  acl        = "log-delivery-write"
  depends_on = [aws_s3_bucket_ownership_controls.cf_logs]
}

# =============================================================================
# CLOUDFRONT — SPA + STATIC SITES
# =============================================================================

resource "aws_cloudfront_origin_access_control" "static" {
  provider                          = aws.us_east_1
  name                              = "${var.project}-static-oac"
  description                       = "OAC for ${var.project} static assets S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "spa" {
  provider            = aws.us_east_1
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project} SPA + static sites"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.cdn.arn

  aliases = [var.static_site_domain]

  # S3 static assets origin
  origin {
    domain_name              = aws_s3_bucket.static.bucket_regional_domain_name
    origin_id                = "s3-static"
    origin_access_control_id = aws_cloudfront_origin_access_control.static.id
  }

  # Default cache behaviour — serve from S3
  default_cache_behavior {
    target_origin_id       = "s3-static"
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

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  # SPA fallback — return index.html for 403/404 (client-side routing)
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  # TLS — certificate must exist in us-east-1
  viewer_certificate {
    # TODO: Set acm_certificate_arn to a validated ACM cert for var.static_site_domain
    # acm_certificate_arn      = aws_acm_certificate_validation.cdn.certificate_arn
    # ssl_support_method        = "sni-only"
    # minimum_protocol_version  = "TLSv1.2_2021"
    cloudfront_default_certificate = true # REPLACE with ACM cert above
  }

  logging_config {
    include_cookies = false
    bucket          = aws_s3_bucket.cf_logs.bucket_domain_name
    prefix          = "cloudfront/"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
      # TODO: Restrict to expected geographies if applicable
    }
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# OUTPUTS
# =============================================================================

output "ec2_instance_id" {
  description = "EC2 instance ID — use SSM Session Manager to connect."
  value       = aws_instance.app.id
}

output "ec2_public_ip" {
  description = "EC2 public IP — point Cloudflare DNS A record here."
  value       = aws_instance.app.public_ip
}

output "static_bucket_name" {
  description = "S3 bucket for static site assets."
  value       = aws_s3_bucket.static.bucket
}

output "backup_bucket_name" {
  description = "S3 bucket for backups and snapshot exports."
  value       = aws_s3_bucket.backup.bucket
}

output "cloudfront_distribution_domain" {
  description = "CloudFront distribution domain name."
  value       = aws_cloudfront_distribution.spa.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID."
  value       = aws_cloudfront_distribution.spa.id
}

output "sns_ops_topic_arn" {
  description = "SNS topic ARN for ops alerts."
  value       = aws_sns_topic.ops.arn
}

output "ebs_volume_id" {
  description = "EBS data volume ID (SQLite store)."
  value       = aws_ebs_volume.db.id
}

output "ssm_parameter_anthropic_key_path" {
  description = "SSM Parameter Store path for Anthropic API key."
  value       = aws_ssm_parameter.anthropic_api_key.name
}

output "ssm_parameter_langfuse_key_paths" {
  description = "SSM paths for the Langfuse keys (empty unless enable_langfuse=true). Set real values via: aws ssm put-parameter --overwrite."
  value       = var.enable_langfuse ? [aws_ssm_parameter.langfuse_public_key[0].name, aws_ssm_parameter.langfuse_secret_key[0].name] : []
}

output "app_log_group_name" {
  description = "CloudWatch Log Group for application logs."
  value       = aws_cloudwatch_log_group.app.name
}