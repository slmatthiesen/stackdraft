/**
 * Edge → wiring glue: the judgment the plan calls "the hard, valuable part".
 *
 * Per-node emitters draw the resources; this walks the typed EDGE list to derive
 * the connective tissue that a free-form HCL model routinely gets wrong:
 *   • IAM least-privilege — each compute node gets exactly the grants its OUTGOING
 *     edges imply (S3 read/write to the bucket it talks to, GetSecretValue for the
 *     secret it reads, InvokeFunction for the Lambda it calls, xray:Put* for a
 *     trace edge, SSM port-forward to reach a co-located Postgres) and nothing more.
 *   • Security groups — an EC2 box fronted by CloudFront accepts 443/80 ONLY from
 *     the CloudFront managed prefix list; a localhost edge (ec2 → self-managed
 *     postgres) needs NO rule because it never crosses the network.
 *
 * Because grants are derived from edges and reference resources by the SAME
 * deterministic name the emitters use, the IAM can't drift from the graph.
 */
import type { ArchitectureNode } from "../../schema/architecture.js";
import { colocatedHost, lambdaNeedsVpc, ref, type EmitCtx } from "./context.js";
import { type HclBlock, type Jsonish, jsonencode, policyDoc, raw } from "./hcl.js";
import { COMPUTE_KEYS } from "./serviceKey.js";

const indentPolicy = (json: string): string =>
  json.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");

const ASSUME_PRINCIPAL: Record<string, string> = { ec2: "ec2.amazonaws.com", lambda: "lambda.amazonaws.com" };
const MANAGED_POLICY: Record<string, string> = {
  ec2: "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore",
  lambda: "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
};
// A VPC-attached Lambda needs ENI management on top of basic logging.
const LAMBDA_VPC_POLICY = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";

/** Build the inline least-priv statements for one compute node from its edges.
 *  Exported so the Fargate emitter (which manages its own roles) reuses the SAME
 *  edge-derivation as EC2/Lambda — IAM stays sourced from the graph, one place. */
export function edgeIamStatements(node: ArchitectureNode, ctx: EmitCtx): Jsonish[] {
  const key = ctx.keyOf(node);
  const statements: Jsonish[] = [];
  let needsKmsMain = false;

  for (const edge of ctx.out(node.id)) {
    const target = ctx.byId(edge.to);
    if (!target) continue;
    const tkey = ctx.keyOf(target);
    const ttf = ctx.tf(target.id);
    switch (tkey) {
      case "s3":
        statements.push({
          Sid: `S3_${ttf}`,
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
          Resource: [raw(ref.s3Arn(ctx, target.id)), raw(`"\${${ref.s3Arn(ctx, target.id)}}/*"`)],
        });
        needsKmsMain = true;
        break;
      case "secrets-manager":
        statements.push({
          Sid: `Secret_${ttf}`,
          Effect: "Allow",
          Action: "secretsmanager:GetSecretValue",
          Resource: raw(ref.secretArn(ctx, target.id)),
        });
        needsKmsMain = true;
        break;
      case "lambda":
        statements.push({
          Sid: `Invoke_${ttf}`,
          Effect: "Allow",
          Action: "lambda:InvokeFunction",
          Resource: raw(ref.lambdaArn(ctx, target.id)),
        });
        break;
      case "sns":
        statements.push({
          Sid: `Publish_${ttf}`,
          Effect: "Allow",
          Action: "sns:Publish",
          Resource: raw(ref.snsArn(ctx, target.id)),
        });
        break;
      case "xray":
        statements.push({
          Sid: "XRayWrite",
          Effect: "Allow",
          Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
          Resource: "*",
        });
        break;
      case "eventbridge-bus":
        statements.push({
          Sid: `PutEvents_${ttf}`,
          Effect: "Allow",
          Action: "events:PutEvents",
          Resource: raw(`aws_cloudwatch_event_bus.${ttf}.arn`),
        });
        break;
      case "sqs":
        statements.push({
          Sid: `SendMessage_${ttf}`,
          Effect: "Allow",
          Action: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
          Resource: raw(`aws_sqs_queue.${ttf}.arn`),
        });
        break;
      case "dynamo":
        statements.push({
          Sid: `Dynamo_${ttf}`,
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:BatchGetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:BatchWriteItem",
          ],
          Resource: [raw(`aws_dynamodb_table.${ttf}.arn`), raw(`"\${aws_dynamodb_table.${ttf}.arn}/index/*"`)],
        });
        needsKmsMain = true;
        break;
      case "kinesis":
        statements.push({
          Sid: `Kinesis_${ttf}`,
          Effect: "Allow",
          Action: ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"],
          Resource: raw(`aws_kinesis_stream.${ttf}.arn`),
        });
        needsKmsMain = true;
        break;
      case "ses":
        statements.push({
          Sid: `SES_${ttf}`,
          Effect: "Allow",
          Action: ["ses:SendEmail", "ses:SendRawEmail"],
          Resource: raw(`aws_sesv2_email_identity.${ttf}.arn`),
        });
        break;
      case "cognito":
        statements.push({
          Sid: `Cognito_${ttf}`,
          Effect: "Allow",
          Action: [
            "cognito-idp:AdminInitiateAuth",
            "cognito-idp:AdminGetUser",
            "cognito-idp:AdminCreateUser",
            "cognito-idp:AdminRespondToAuthChallenge",
          ],
          Resource: raw(`aws_cognito_user_pool.${ttf}.arn`),
        });
        break;
      case "step-functions":
        statements.push({
          Sid: `StartExecution_${ttf}`,
          Effect: "Allow",
          Action: "states:StartExecution",
          Resource: raw(`aws_sfn_state_machine.${ttf}.arn`),
        });
        break;
      case "opensearch":
        statements.push({
          Sid: `OpenSearch_${ttf}`,
          Effect: "Allow",
          Action: ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"],
          Resource: raw(`"\${aws_opensearch_domain.${ttf}.arn}/*"`),
        });
        break;
      case "postgres-selfmanaged": {
        // A localhost edge from the box ITSELF crosses no network — no grant. A Lambda
        // reaching the co-located Postgres tunnels in via SSM port-forward to the host.
        if (key === "lambda") {
          const host = colocatedHost(ctx, target.id);
          if (host) {
            statements.push({
              Sid: "SSMPortForward",
              Effect: "Allow",
              Action: ["ssm:StartSession", "ssm:TerminateSession", "ssm:DescribeSessions"],
              Resource: [
                raw(ref.instanceArn(ctx, host.id)),
                raw('"arn:${local.partition}:ssm:${local.region}:${local.account_id}:document/AWS-StartPortForwardingSession"'),
              ],
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Security-tag fallback for secrets (plan: derive IAM from "the edge list + security
  // tags"). A design often tags a worker "Secrets Manager creds" without drawing an
  // explicit edge to the secret — without this the worker would have no GetSecretValue
  // grant and fail to fetch credentials at runtime. If the node's tags imply secrets
  // access and no edge already granted it, grant read on the tier's secret(s).
  const alreadyGrantedSecret = ctx
    .out(node.id)
    .some((e) => ctx.byId(e.to) && ctx.keyOf(ctx.byId(e.to)!) === "secrets-manager");
  const tagsImplySecret = node.security.some((s) => /secret|credential/i.test(s));
  if (!alreadyGrantedSecret && tagsImplySecret) {
    for (const secret of ctx.nodesOfKey("secrets-manager")) {
      statements.push({
        Sid: `Secret_${ctx.tf(secret.id)}`,
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: raw(ref.secretArn(ctx, secret.id)),
      });
      needsKmsMain = true;
    }
  }

  // Only when the tier emits the customer-managed `main` CMK (balanced+/compliance). At
  // the budget floor the data is encrypted with AWS-managed keys, which authorize use
  // via the service + caller IAM and need no explicit kms grant — and the CMK resource
  // isn't emitted, so referencing it would break `terraform validate`.
  if (needsKmsMain && ctx.paidSecurity) {
    statements.push({
      Sid: "KMSDecryptMain",
      Effect: "Allow",
      Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
      Resource: raw("aws_kms_key.main.arn"),
    });
  }
  if (key === "ec2" || key === "fargate") {
    // The CloudWatch agent / awslogs driver ships logs — scope to the tier's log-group tree.
    statements.push({
      Sid: "CloudWatchLogsWrite",
      Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
      Resource: raw(`"arn:\${local.partition}:logs:\${local.region}:\${local.account_id}:log-group:/${ctx.prefix}/*"`),
    });
  }
  return statements;
}

/** All IAM (roles, managed attachments, instance profiles, inline policies) +
 *  security groups for the tier's compute nodes. */
export function emitGlue(ctx: EmitCtx): HclBlock[] {
  const blocks: HclBlock[] = [];
  const compute = ctx.nodes.filter((n) => COMPUTE_KEYS.has(ctx.keyOf(n)));

  // Shared assume-role documents, one per service principal (deduped).
  for (const key of new Set(compute.map((n) => ctx.keyOf(n)))) {
    const principal = ASSUME_PRINCIPAL[key];
    if (!principal) continue;
    blocks.push({
      section: "IAM",
      dedupeKey: `assume-${key}`,
      hcl: [
        `data "aws_iam_policy_document" "${key}_assume" {`,
        `  statement {`,
        `    actions = ["sts:AssumeRole"]`,
        `    principals {`,
        `      type        = "Service"`,
        `      identifiers = ["${principal}"]`,
        `    }`,
        `  }`,
        `}`,
      ].join("\n"),
    });
  }

  for (const node of compute) {
    const key = ctx.keyOf(node);
    const tf = ctx.tf(node.id);
    const lines: string[] = [
      `resource "aws_iam_role" "${tf}" {`,
      `  name               = "${ctx.prefix}-${tf.replace(/_/g, "-")}-role"`,
      `  assume_role_policy = data.aws_iam_policy_document.${key}_assume.json`,
      `}`,
      ``,
      `resource "aws_iam_role_policy_attachment" "${tf}_managed" {`,
      `  role       = aws_iam_role.${tf}.name`,
      `  policy_arn = "${key === "lambda" && lambdaNeedsVpc(ctx, node) ? LAMBDA_VPC_POLICY : MANAGED_POLICY[key]}"`,
      `}`,
    ];

    const statements = edgeIamStatements(node, ctx);
    if (statements.length > 0) {
      lines.push(
        ``,
        `resource "aws_iam_role_policy" "${tf}_inline" {`,
        `  name = "${ctx.prefix}-${tf.replace(/_/g, "-")}-inline"`,
        `  role = aws_iam_role.${tf}.id`,
        `  policy = ${indentPolicy(jsonencode(policyDoc(statements)))}`,
        `}`,
      );
    }

    if (key === "ec2") {
      lines.push(
        ``,
        `resource "aws_iam_instance_profile" "${tf}" {`,
        `  name = "${ctx.prefix}-${tf.replace(/_/g, "-")}-profile"`,
        `  role = aws_iam_role.${tf}.name`,
        `}`,
      );
    }

    blocks.push({ section: `IAM — ${node.role}`, hcl: lines.join("\n") });

    if (key === "ec2") {
      const frontedByCf = ctx.in(node.id).some((e) => {
        const from = ctx.byId(e.from);
        return from && ctx.keyOf(from) === "cloudfront";
      });
      if (frontedByCf) {
        // One managed-prefix-list data source for the whole tier (deduped), so two
        // CF-fronted boxes don't redeclare it.
        blocks.push({
          section: "Networking",
          dedupeKey: "cf-prefix-list",
          hcl: [
            `data "aws_ec2_managed_prefix_list" "cloudfront" {`,
            `  name = "com.amazonaws.global.cloudfront.origin-facing"`,
            `}`,
          ].join("\n"),
        });
      }
      blocks.push(emitSecurityGroup(node, ctx, frontedByCf));
    }
  }

  return blocks;
}

/** SG for an EC2 box: ingress only from CloudFront (managed prefix list) when a CDN
 *  fronts it; otherwise 443/80 from the internet with an explicit note. */
function emitSecurityGroup(node: ArchitectureNode, ctx: EmitCtx, frontedByCf: boolean): HclBlock {
  const tf = ctx.tf(node.id);

  const ingress = frontedByCf
    ? [
        `  ingress {`,
        `    description     = "HTTPS from CloudFront only"`,
        `    from_port       = 443`,
        `    to_port         = 443`,
        `    protocol        = "tcp"`,
        `    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]`,
        `  }`,
        ``,
        `  ingress {`,
        `    description     = "HTTP from CloudFront only (redirect)"`,
        `    from_port       = 80`,
        `    to_port         = 80`,
        `    protocol        = "tcp"`,
        `    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]`,
        `  }`,
      ]
    : [
        `  ingress {`,
        `    description = "HTTPS from the internet (no CDN in front of this box)"`,
        `    from_port   = 443`,
        `    to_port     = 443`,
        `    protocol    = "tcp"`,
        `    cidr_blocks = ["0.0.0.0/0"]`,
        `  }`,
      ];

  return {
    section: `Security group — ${node.role}`,
    hcl: [
      `resource "aws_security_group" "${tf}" {`,
      `  name        = "${ctx.prefix}-${tf.replace(/_/g, "-")}-sg"`,
      `  description = "Ingress for ${node.role}; egress to AWS services"`,
      `  vpc_id      = aws_vpc.main.id`,
      ``,
      ...ingress,
      ``,
      `  egress {`,
      `    description = "All outbound"`,
      `    from_port   = 0`,
      `    to_port     = 0`,
      `    protocol    = "-1"`,
      `    cidr_blocks = ["0.0.0.0/0"]`,
      `  }`,
      ``,
      `  tags = { Name = "${ctx.prefix}-${tf.replace(/_/g, "-")}-sg" }`,
      `}`,
    ].join("\n"),
    dedupeKey: undefined,
  };
}
