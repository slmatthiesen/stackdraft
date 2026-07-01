/**
 * Terraform artifact framing + the wire-up-gap detector — shared by BOTH the LLM
 * path (`routes/config.ts`) and the deterministic emitter (`assemble.ts`).
 *
 * Extracted here (the plan's step 1: "port the file header/disclaimer and
 * flagIfIncomplete from routes/config.ts") so the deterministic assembler can reuse
 * them WITHOUT importing the route handler — which would otherwise create a cycle
 * (config.ts → assemble.ts → config.ts). `routes/config.ts` re-exports every symbol
 * so existing importers (the offline generator, the route tests) are untouched.
 *
 * The detector is the contract the deterministic templates are tested against: each
 * `id` matches a rule in `@drafture/kb/terraform-wireup-rules.json`. For the LLM
 * path it's a post-hoc warning; for the templated path the gaps are structurally
 * impossible, so `detectWireupGaps()` returning ZERO is the assembler's invariant.
 */

/**
 * Strip a Markdown code fence the model wraps the HCL in (```hcl … ```), so the
 * artifact is valid Terraform, not a fenced snippet. We instruct plain HCL, but
 * models still fence it intermittently; this is the provider-agnostic backstop.
 * Removes a leading ```lang line and a trailing ``` line; leaves un-fenced output
 * untouched.
 */
export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/;
  const m = fence.exec(trimmed);
  if (m) return m[1]!.trim();
  // Tolerate a missing closing fence (e.g. truncated output): drop just the opener.
  return trimmed.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "");
}

/**
 * Backstop for a design too large to render in one file even at the raised token
 * budget: unbalanced braces mean the HCL was cut off mid-resource. Rather than ship a
 * file that won't parse and looks broken, append a clear marker so the user knows it's
 * incomplete and why. Valid HCL keeps braces balanced (interpolation `${…}` and
 * `jsonencode({…})` pairs included), so an imbalance is a reliable truncation signal.
 */
export function flagIfIncomplete(hcl: string): string {
  const opens = (hcl.match(/{/g) ?? []).length;
  const closes = (hcl.match(/}/g) ?? []).length;
  if (opens === closes) return hcl;
  return (
    `${hcl.trimEnd()}\n\n` +
    `# ============================================================================\n` +
    `# ⚠  INCOMPLETE — this reference file was cut off (the design is too large to\n` +
    `# render as a single Terraform file). It will NOT 'terraform plan' as-is.\n` +
    `# Pull a smaller tier, or split the design, and regenerate.\n` +
    `# ============================================================================\n`
  );
}

/**
 * A wire-up gap the model omitted: a resource present WITHOUT the second-order
 * consequence that makes it work at runtime (a CMK with no key policy, an ACM
 * cert with no validation resource, …). `terraform plan` stays green on every one
 * — they fail at runtime — so this is the only place they're surfaced. Each `id`
 * matches a rule in `@drafture/kb/terraform-wireup-rules.json` (the prompt segment
 * `renderTerraformWireupRules()` teaches the model to avoid these in the first
 * place; this is the backstop for when it still drops one).
 */
export interface WireupGap {
  id: string;
  message: string;
}

/**
 * Detect wire-up gaps in generated HCL. Pure, conservative (passes on ambiguity),
 * regex/keyword-based — there is no HCL parser in the tree, so this mirrors the
 * keyword-vocabulary convention of `test/golden/properties.ts`. Each check fires
 * only on a clear signal that the consequence is missing.
 */
export function detectWireupGaps(hcl: string): WireupGap[] {
  const gaps: WireupGap[] = [];
  const has = (re: RegExp): boolean => re.test(hcl);
  const hasCmkKeyPolicy = has(/resource\s+"aws_kms_key_policy"/);

  // kms-key-policy — scoped to the services that genuinely NEED a service-principal
  // grant (Logs/SNS). DynamoDB/S3/SQS/EBS work via caller IAM, so a CMK for those
  // alone does not require a service-principal key policy (would false-flag). A
  // `kms_key_id` set to an AWS-MANAGED alias (`alias/aws/*`, e.g. a Kinesis stream's
  // `alias/aws/kinesis`) is excluded — managed keys carry their own service grants, so
  // an unrelated managed-alias encryption must not read as a CMK-encrypted log group.
  if (
    has(/resource\s+"aws_cloudwatch_log_group"/) &&
    has(/kms_key_id\s*=\s*(?=\S)(?!"alias\/)/) &&
    !hasCmkKeyPolicy &&
    !has(/logs\.[a-z0-9-]+\.amazonaws\.com/)
  ) {
    gaps.push({
      id: "kms-key-policy",
      message:
        "A KMS-encrypted CloudWatch Logs group needs `logs.<region>.amazonaws.com` granted kms:Decrypt/GenerateDataKey* in the CMK key policy, or PutLogEvents fails at runtime.",
    });
  }
  if (
    has(/resource\s+"aws_sns_topic"/) &&
    has(/kms_master_key_id/) &&
    !hasCmkKeyPolicy &&
    !has(/(?:cloudwatch|sns)\.amazonaws\.com/)
  ) {
    gaps.push({
      id: "kms-key-policy",
      message:
        "A KMS-encrypted SNS topic that receives CloudWatch alarm actions needs `cloudwatch.amazonaws.com`/`sns.amazonaws.com` in the CMK key policy, or alarm publish fails at runtime.",
    });
  }

  // cloudfront-origin-tls
  if (
    has(/origin_protocol_policy\s*=\s*"https-only"/) &&
    has(/resource\s+"aws_instance"/) &&
    has(/public_dns/)
  ) {
    gaps.push({
      id: "cloudfront-origin-tls",
      message:
        "A CloudFront https-only origin targets an EC2 public_dns — no trusted CA cert exists for *.compute-1.amazonaws.com and the DNS churns on replacement. Use an ALB+ACM origin, EIP+domain+cert, or API Gateway/Lambda.",
    });
  }

  // acm-certificate-validation
  if (
    has(/resource\s+"aws_acm_certificate"/) &&
    has(/validation_method\s*=\s*"DNS"/) &&
    !has(/resource\s+"aws_acm_certificate_validation"/)
  ) {
    gaps.push({
      id: "acm-certificate-validation",
      message:
        "A DNS-validated ACM cert has no aws_acm_certificate_validation + Route53 records — it stays PENDING_VALIDATION and HTTPS won't serve.",
    });
  }

  // secretsmanager-rotation-lambda
  if (
    has(/resource\s+"aws_secretsmanager_secret_rotation"/) &&
    has(/rotation_lambda_arn\s*=\s*null/)
  ) {
    gaps.push({
      id: "secretsmanager-rotation-lambda",
      message:
        "aws_secretsmanager_secret_rotation has rotation_lambda_arn = null — invalid. Supply a real rotation Lambda or omit the resource.",
    });
  }

  // s3-access-log-delivery — require the actual log-delivery principal (the CF
  // canonical-user data source, or a CanonicalUser principal), NOT merely "some
  // bucket policy exists": a policy on an UNRELATED bucket (e.g. an OAC on a
  // dashboard bucket) must not mask a missing delivery grant on the logs bucket.
  if (
    has(/logging_config\s*\{/) &&
    !has(/aws_cloudfront_log_delivery_canonical_user_ids/) &&
    !has(/CanonicalUser/)
  ) {
    gaps.push({
      id: "s3-access-log-delivery",
      message:
        "A CloudFront/S3 access-log bucket has no log-delivery grant (canonical user / cloudfront principal s3:PutObject) — with Block Public Access, logging silently no-ops.",
    });
  }

  return gaps;
}

/**
 * Append a `# ⚠ WIRE-UP GAP` banner (flagIfIncomplete convention: plain `#`
 * comments = valid HCL, survives `terraform plan`) listing detected gaps so a
 * human reviewer sees them in the artifact itself. Never mutates HCL semantics —
 * annotate-only is the safe choice; deterministic auto-repair of free-form HCL is
 * fragile and deliberately out of scope.
 */
export function annotateWireupGaps(hcl: string): string {
  const gaps = detectWireupGaps(hcl);
  if (gaps.length === 0) return hcl;
  const lines = gaps.map((g) => `# ⚠  [${g.id}] ${g.message}`);
  return (
    `${hcl.trimEnd()}\n\n` +
    `# ============================================================================\n` +
    `# ⚠  WIRE-UP GAPS — the resources above compile, but these FAIL or no-op at\n` +
    `# runtime. 'terraform plan' stays green on each, so review and fix before apply.\n` +
    `${lines.join("\n")}\n` +
    `# ============================================================================\n`
  );
}

/**
 * Warning banner prepended to the generated HCL itself (before line 1), so the danger
 * travels WITH the file even after it's copied out of the UI's red banner. Plain `#`
 * comments = valid HCL, survive copy/paste into an editor or `terraform` run.
 */
export const REFERENCE_WARNING_HEADER = `##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run \`terraform plan\`, set a billing budget — you own every resource it creates.
##############################################################################

`;
