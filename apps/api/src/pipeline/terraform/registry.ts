/**
 * The provider-abstracted emitter registry: `serviceKey → ServiceEmitter`. New
 * services drop in by registering one entry — exactly the factory/registry shape
 * the project uses elsewhere instead of a hard-coded switch. A node whose key has
 * no entry is "unsupported" and routes to the assembler's hybrid LLM fallback.
 */
import type { ArchitectureNode } from "../../schema/architecture.js";
import type { EmitCtx } from "./context.js";
import type { HclBlock } from "./hcl.js";
import type { ServiceKey } from "./serviceKey.js";

import { emitS3, emitSecrets } from "./emitters/storage.js";
import { emitEc2, emitLambda, emitPostgres } from "./emitters/compute.js";
import { emitCloudfront } from "./emitters/cloudfront.js";
import { emitScheduler } from "./emitters/scheduler.js";
import { emitAlb, emitElasticache, emitFargate, emitOpenSearch, emitRds } from "./emitters/managed.js";
import { emitApiGateway, emitDynamo } from "./emitters/serverless.js";
import { emitCognito, emitKinesis, emitSes, emitStepFunctions } from "./emitters/integration.js";
import {
  emitCloudtrail,
  emitCloudwatchAlarms,
  emitCloudwatchLogs,
  emitSns,
  emitXray,
} from "./emitters/observability.js";
import {
  emitCloudwatchAnomaly,
  emitCloudwatchDashboard,
  emitEventbridgeBus,
  emitNat,
  emitSqs,
} from "./emitters/misc.js";

export type ServiceEmitter = (node: ArchitectureNode, ctx: EmitCtx) => HclBlock[];

export const REGISTRY: ReadonlyMap<ServiceKey, ServiceEmitter> = new Map<ServiceKey, ServiceEmitter>([
  ["s3", emitS3],
  ["secrets-manager", emitSecrets],
  ["ec2", emitEc2],
  ["postgres-selfmanaged", emitPostgres],
  ["lambda", emitLambda],
  ["cloudfront", emitCloudfront],
  ["eventbridge-scheduler", emitScheduler],
  ["sns", emitSns],
  ["cloudwatch-logs", emitCloudwatchLogs],
  ["cloudwatch-alarms", emitCloudwatchAlarms],
  ["xray", emitXray],
  ["cloudtrail", emitCloudtrail],
  ["alb", emitAlb],
  ["fargate", emitFargate],
  ["rds", emitRds],
  ["elasticache", emitElasticache],
  ["nat", emitNat],
  ["cloudwatch-dashboard", emitCloudwatchDashboard],
  ["cloudwatch-anomaly", emitCloudwatchAnomaly],
  ["sqs", emitSqs],
  ["eventbridge-bus", emitEventbridgeBus],
  ["dynamo", emitDynamo],
  ["apigw", emitApiGateway],
  ["cognito", emitCognito],
  ["ses", emitSes],
  ["step-functions", emitStepFunctions],
  ["kinesis", emitKinesis],
  ["opensearch", emitOpenSearch],
]);
