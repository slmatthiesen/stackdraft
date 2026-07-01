/**
 * Integration-service emitters — the common services a design reaches for that used
 * to fall to the LLM fallback (and drag the whole tier to a 32k-token HCL call):
 * Cognito (auth/login), SES (email delivery with bounce/complaint event publishing),
 * Step Functions (a state-machine orchestrator over the Lambdas its edges target),
 * and Kinesis (a data stream + its consumer's event-source mapping). Each turns a
 * minute-long LLM emission into instant $0 deterministic HCL. All wiring — the state
 * machine's task chain, the stream's consumer mapping + read grant — is derived from
 * the typed edges, never invented.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { ref, type EmitCtx } from "../context.js";
import { type HclBlock, type Jsonish, jsonencode, policyDoc, raw } from "../hcl.js";

const indentPolicy = (json: string): string =>
  json.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");
const dash = (tf: string): string => tf.replace(/_/g, "-");

// --- Cognito -----------------------------------------------------------------

export function emitCognito(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `Cognito — ${node.role}`;
  return [
    {
      section,
      hcl: [
        `resource "aws_cognito_user_pool" "${tf}" {`,
        `  name = "${ctx.prefix}-${dash(tf)}"`,
        ``,
        `  password_policy {`,
        `    minimum_length    = 12`,
        `    require_lowercase = true`,
        `    require_uppercase = true`,
        `    require_numbers   = true`,
        `    require_symbols   = true`,
        `  }`,
        ``,
        `  # MFA available (software TOTP); require it for privileged pools in review.`,
        `  mfa_configuration = "OPTIONAL"`,
        `  software_token_mfa_configuration {`,
        `    enabled = true`,
        `  }`,
        ``,
        `  auto_verified_attributes = ["email"]`,
        `  account_recovery_setting {`,
        `    recovery_mechanism {`,
        `      name     = "verified_email"`,
        `      priority = 1`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `resource "aws_cognito_user_pool_client" "${tf}" {`,
        `  name            = "${ctx.prefix}-${dash(tf)}-client"`,
        `  user_pool_id    = aws_cognito_user_pool.${tf}.id`,
        `  generate_secret = true`,
        `  explicit_auth_flows = [`,
        `    "ALLOW_USER_SRP_AUTH",`,
        `    "ALLOW_REFRESH_TOKEN_AUTH",`,
        `  ]`,
        `}`,
      ].join("\n"),
    },
  ];
}

// --- SES ---------------------------------------------------------------------

export function emitSes(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `SES — ${node.role}`;
  return [
    {
      section,
      hcl: [
        `variable "${tf}_domain" {`,
        `  type        = string`,
        `  description = "Verified sending domain/identity for SES ${node.role} (e.g. mail.example.com)."`,
        `}`,
        ``,
        `resource "aws_sesv2_email_identity" "${tf}" {`,
        `  email_identity = var.${tf}_domain`,
        `}`,
        ``,
        `resource "aws_sesv2_configuration_set" "${tf}" {`,
        `  configuration_set_name = "${ctx.prefix}-${dash(tf)}"`,
        `  delivery_options {`,
        `    tls_policy = "REQUIRE"`,
        `  }`,
        `  reputation_options {`,
        `    reputation_metrics_enabled = true`,
        `  }`,
        `}`,
        ``,
        `# Publish delivery/bounce/complaint events so the send is observable + retryable`,
        `# (a bare SNS email subscription gives no per-message delivery ack).`,
        `resource "aws_sesv2_configuration_set_event_destination" "${tf}" {`,
        `  configuration_set_name = aws_sesv2_configuration_set.${tf}.configuration_set_name`,
        `  event_destination_name = "cloudwatch"`,
        `  event_destination {`,
        `    enabled              = true`,
        `    matching_event_types = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT"]`,
        `    cloud_watch_destination {`,
        `      dimension_configuration {`,
        `        default_dimension_value = "none"`,
        `        dimension_name          = "ses:configuration-set"`,
        `        dimension_value_source  = "MESSAGE_TAG"`,
        `      }`,
        `    }`,
        `  }`,
        `}`,
      ].join("\n"),
    },
  ];
}

// --- Step Functions ----------------------------------------------------------

export function emitStepFunctions(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `Step Functions — ${node.role}`;

  // The state machine orchestrates the Lambda(s) its edges target — one Task state per
  // Lambda, chained in edge order, the last one ending the execution.
  const lambdaTargets = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) === "lambda");

  const states: Record<string, Jsonish> = {};
  if (lambdaTargets.length === 0) {
    states["Done"] = { Type: "Pass", End: true };
  } else {
    lambdaTargets.forEach((t, i) => {
      const stateName = `Invoke_${ctx.tf(t.id)}`;
      const last = i === lambdaTargets.length - 1;
      states[stateName] = {
        Type: "Task",
        Resource: raw(ref.lambdaArn(ctx, t.id)),
        ...(last ? { End: true } : { Next: `Invoke_${ctx.tf(lambdaTargets[i + 1]!.id)}` }),
      };
    });
  }
  const startAt = Object.keys(states)[0]!;
  const definition = jsonencode({
    Comment: node.role,
    StartAt: startAt,
    States: states,
  });

  const blocks: HclBlock[] = [
    {
      section,
      hcl: [
        `data "aws_iam_policy_document" "${tf}_assume" {`,
        `  statement {`,
        `    actions = ["sts:AssumeRole"]`,
        `    principals {`,
        `      type        = "Service"`,
        `      identifiers = ["states.amazonaws.com"]`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `resource "aws_iam_role" "${tf}" {`,
        `  name               = "${ctx.prefix}-${dash(tf)}"`,
        `  assume_role_policy = data.aws_iam_policy_document.${tf}_assume.json`,
        `}`,
      ].join("\n"),
    },
  ];

  if (lambdaTargets.length > 0) {
    blocks.push({
      section,
      hcl: [
        `resource "aws_iam_role_policy" "${tf}_invoke" {`,
        `  name = "${ctx.prefix}-${dash(tf)}-invoke"`,
        `  role = aws_iam_role.${tf}.id`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Sid: "InvokeTargets",
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: lambdaTargets.map((t) => raw(ref.lambdaArn(ctx, t.id))),
              },
            ]),
          ),
        )}`,
        `}`,
      ].join("\n"),
    });
  }

  blocks.push({
    section,
    hcl: [
      `resource "aws_sfn_state_machine" "${tf}" {`,
      `  name     = "${ctx.prefix}-${dash(tf)}"`,
      `  role_arn = aws_iam_role.${tf}.arn`,
      `  definition = ${indentPolicy(definition)}`,
      `}`,
    ].join("\n"),
  });

  return blocks;
}

// --- Kinesis -----------------------------------------------------------------

export function emitKinesis(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `Kinesis — ${node.role}`;

  const consumers = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) === "lambda");

  const blocks: HclBlock[] = [
    {
      section,
      hcl: [
        `resource "aws_kinesis_stream" "${tf}" {`,
        `  name             = "${ctx.prefix}-${dash(tf)}"`,
        `  retention_period = 24`,
        `  stream_mode_details {`,
        `    stream_mode = "ON_DEMAND"`,
        `  }`,
        `  encryption_type = "KMS"`,
        // Budget floor: the AWS-managed alias/aws/kinesis key (free). Balanced+: a CMK.
        `  kms_key_id      = ${ctx.paidSecurity ? "aws_kms_key.main.arn" : '"alias/aws/kinesis"'}`,
        `}`,
      ].join("\n"),
    },
  ];

  // A kinesis → lambda edge is an event-source mapping; wire the mapping + the consumer's
  // stream-read grant (an INCOMING edge to the Lambda, which the outgoing-edge IAM misses).
  for (const consumer of consumers) {
    const ctf = ctx.tf(consumer.id);
    blocks.push({
      section,
      hcl: [
        `resource "aws_lambda_event_source_mapping" "${tf}_${ctf}" {`,
        `  event_source_arn  = aws_kinesis_stream.${tf}.arn`,
        `  function_name     = ${ref.lambda(ctx, consumer.id)}.arn`,
        `  starting_position = "LATEST"`,
        `  batch_size        = 100`,
        `}`,
        ``,
        `resource "aws_iam_role_policy" "${ctf}_kinesis_${tf}" {`,
        `  name = "${ctx.prefix}-${dash(ctf)}-kinesis-${dash(tf)}"`,
        `  role = ${ref.role(ctx, consumer.id)}.id`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Sid: "ReadStream",
                Effect: "Allow",
                Action: [
                  "kinesis:GetRecords",
                  "kinesis:GetShardIterator",
                  "kinesis:DescribeStream",
                  "kinesis:DescribeStreamSummary",
                  "kinesis:ListShards",
                ],
                Resource: raw(`aws_kinesis_stream.${tf}.arn`),
              },
            ]),
          ),
        )}`,
        `}`,
      ].join("\n"),
    });
  }

  return blocks;
}
