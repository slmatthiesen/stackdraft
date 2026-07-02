/**
 * DynamoDB-backed GenerationsStore — the gallery + model-improvement backbone.
 *
 * One `generations` table: the design at (id, sk="meta"), each voter's vote at
 * (id, sk=`vote#<voter>`). A sparse `promptHash-index` GSI (only the meta item carries
 * `promptHash`) powers `getByPromptHash` and the upsert-by-promptHash lookup. Votes use
 * the same optimistic one-vote-per-voter scheme as the curated store, plus the
 * auto-hide-at-threshold transition computed from the post-update counts.
 *
 * `listPending`/`listApproved` are small filtered Scans ranked in app — the gallery is
 * a few dozen rows today (plan §2: measure before indexing). `setTerraform` is a
 * read-modify-write of the per-tier JSON map (best-effort, low-concurrency lazy cache).
 */
import { randomBytes } from "node:crypto";

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import type {
  GenerationRecord,
  GenerationStats,
  GenerationStatus,
  GenerationSummary,
  GenerationUpsertResult,
  GenerationVoteResult,
  GenerationsStore,
} from "../types.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { DynamoDeps } from "./client.js";
import { aggregateGenerationStats } from "../stats.js";

const META = "meta";
const MAX_VOTE_ATTEMPTS = 8;

/** 12 url-safe chars (~72 bits) — short shareable deep-link id, stable across re-runs. */
function newId(): string {
  return randomBytes(9).toString("base64url");
}

function parseStatus(s: unknown): GenerationStatus {
  return s === "approved" || s === "hidden" ? s : "pending";
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

interface MetaItem {
  id: string;
  sk: string;
  promptHash: string;
  description: string;
  answers: string[];
  model: string;
  region: string;
  recommendedTier: string;
  tags: string[];
  body: string;
  terraformJson: string | null;
  status: string;
  optOut: boolean;
  genCount: number;
  clientIp: string;
  upvotes: number;
  downvotes: number;
  createdAt: number;
  updatedAt: number;
}

function toRecord(item: MetaItem): GenerationRecord {
  return {
    id: item.id,
    promptHash: item.promptHash,
    description: item.description,
    answers: item.answers ?? [],
    model: item.model,
    region: item.region,
    recommendedTier: item.recommendedTier,
    tags: item.tags ?? [],
    body: item.body,
    terraformJson: item.terraformJson ?? null,
    status: parseStatus(item.status),
    optOut: item.optOut === true,
    genCount: item.genCount,
    clientIp: item.clientIp,
    upvotes: item.upvotes,
    downvotes: item.downvotes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toSummary(item: MetaItem): GenerationSummary {
  return {
    id: item.id,
    description: item.description,
    recommendedTier: item.recommendedTier,
    tags: item.tags ?? [],
    status: parseStatus(item.status),
    upvotes: item.upvotes,
    downvotes: item.downvotes,
    genCount: item.genCount,
    model: item.model,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export class DynamoGenerationsStore implements GenerationsStore {
  constructor(
    private readonly deps: DynamoDeps,
    private readonly clock: Clock = systemClock,
  ) {}

  private get table(): string {
    return this.deps.table("generations");
  }

  private async findByPromptHash(promptHash: string): Promise<MetaItem | undefined> {
    const res = await this.deps.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "promptHash-index",
        KeyConditionExpression: "promptHash = :ph",
        ExpressionAttributeValues: { ":ph": promptHash },
        Limit: 1,
      }),
    );
    return res.Items?.[0] as MetaItem | undefined;
  }

  async upsert(input: {
    promptHash: string;
    description: string;
    answers: string[];
    model: string;
    region: string;
    recommendedTier: string;
    tags: string[];
    body: string;
    clientIp: string;
  }): Promise<GenerationUpsertResult> {
    const now = this.clock.now();
    const existing = await this.findByPromptHash(input.promptHash);

    if (existing) {
      // Refresh content + bump genCount; PRESERVE id/status/votes/terraform/optOut/createdAt.
      await this.deps.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { id: existing.id, sk: META },
          UpdateExpression:
            "SET description = :description, answers = :answers, recommendedTier = :recommendedTier, " +
            "tags = :tags, body = :body, updatedAt = :now ADD genCount :one",
          ExpressionAttributeValues: {
            ":description": input.description,
            ":answers": input.answers,
            ":recommendedTier": input.recommendedTier,
            ":tags": input.tags,
            ":body": input.body,
            ":now": now,
            ":one": 1,
          },
        }),
      );
      return { id: existing.id, status: parseStatus(existing.status) };
    }

    const id = newId();
    const item: MetaItem = {
      id,
      sk: META,
      promptHash: input.promptHash,
      description: input.description,
      answers: input.answers,
      model: input.model,
      region: input.region,
      recommendedTier: input.recommendedTier,
      tags: input.tags,
      body: input.body,
      terraformJson: null,
      status: "pending",
      optOut: false,
      genCount: 1,
      clientIp: input.clientIp,
      upvotes: 0,
      downvotes: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.doc.send(new PutCommand({ TableName: this.table, Item: item }));
    return { id, status: "pending" };
  }

  async getById(id: string): Promise<GenerationRecord | undefined> {
    const res = await this.deps.doc.send(new GetCommand({ TableName: this.table, Key: { id, sk: META } }));
    return res.Item ? toRecord(res.Item as MetaItem) : undefined;
  }

  async getByPromptHash(promptHash: string): Promise<GenerationRecord | undefined> {
    const item = await this.findByPromptHash(promptHash);
    return item ? toRecord(item) : undefined;
  }

  private async listByStatus(status: GenerationStatus): Promise<MetaItem[]> {
    const res = await this.deps.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: "sk = :meta AND #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":meta": META, ":status": status },
      }),
    );
    return (res.Items ?? []) as MetaItem[];
  }

  async listPending(limit: number): Promise<GenerationSummary[]> {
    const items = await this.listByStatus("pending");
    items.sort((a, b) => b.createdAt - a.createdAt); // newest first
    return items.slice(0, limit).map(toSummary);
  }

  async listApproved(limit: number): Promise<GenerationSummary[]> {
    const items = await this.listByStatus("approved");
    items.sort((a, b) => b.upvotes - b.downvotes - (a.upvotes - a.downvotes) || b.updatedAt - a.updatedAt);
    return items.slice(0, limit).map(toSummary);
  }

  async setStatus(id: string, status: GenerationStatus): Promise<boolean> {
    try {
      await this.deps.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { id, sk: META },
          UpdateExpression: "SET #status = :status, updatedAt = :now",
          ConditionExpression: "attribute_exists(id)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": status, ":now": this.clock.now() },
        }),
      );
      return true;
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }

  async getTerraform(id: string, tierName: string): Promise<{ code: string } | undefined> {
    const res = await this.deps.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { id, sk: META },
        ProjectionExpression: "terraformJson",
      }),
    );
    const raw = res.Item?.terraformJson as string | null | undefined;
    if (!raw) return undefined;
    const map = safeParse<Record<string, { code?: string }>>(raw, {});
    const entry = map[tierName];
    return entry?.code ? { code: entry.code } : undefined;
  }

  async setTerraform(id: string, tierName: string, code: string): Promise<boolean> {
    const res = await this.deps.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { id, sk: META },
        ProjectionExpression: "terraformJson",
      }),
    );
    if (!res.Item) return false;
    const map = safeParse<Record<string, { code: string; format: string }>>(
      res.Item.terraformJson as string | null,
      {},
    );
    map[tierName] = { code, format: "terraform" };
    await this.deps.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { id, sk: META },
        UpdateExpression: "SET terraformJson = :tf, updatedAt = :now",
        ExpressionAttributeValues: { ":tf": JSON.stringify(map), ":now": this.clock.now() },
      }),
    );
    return true;
  }

  async vote(
    id: string,
    voter: string,
    value: 1 | -1,
    hideThreshold: number,
  ): Promise<GenerationVoteResult | undefined> {
    for (let attempt = 0; attempt < MAX_VOTE_ATTEMPTS; attempt++) {
      const metaRes = await this.deps.doc.send(
        new GetCommand({ TableName: this.table, Key: { id, sk: META }, ConsistentRead: true }),
      );
      const meta = metaRes.Item as MetaItem | undefined;
      if (!meta) return undefined;

      const voteRes = await this.deps.doc.send(
        new GetCommand({ TableName: this.table, Key: { id, sk: `vote#${voter}` }, ConsistentRead: true }),
      );
      const prior = (voteRes.Item?.value as 1 | -1 | undefined) ?? 0;

      const du = (value === 1 ? 1 : 0) - (prior === 1 ? 1 : 0);
      const dd = (value === -1 ? 1 : 0) - (prior === -1 ? 1 : 0);
      const newUp = meta.upvotes + du;
      const newDown = meta.downvotes + dd;
      const curStatus = parseStatus(meta.status);
      // Community-driven removal: an approved design whose net score sours drops back
      // into the review queue. Hard-delete stays a manual operator action.
      const newStatus: GenerationStatus =
        curStatus === "approved" && newUp - newDown <= hideThreshold ? "hidden" : curStatus;

      if (prior === value) {
        return { upvotes: meta.upvotes, downvotes: meta.downvotes, status: curStatus };
      }

      try {
        await this.deps.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.table,
                  Item: { id, sk: `vote#${voter}`, value, createdAt: this.clock.now() },
                  ConditionExpression: "attribute_not_exists(sk) OR #value = :prior",
                  ExpressionAttributeNames: { "#value": "value" },
                  ExpressionAttributeValues: { ":prior": prior },
                },
              },
              {
                Update: {
                  TableName: this.table,
                  Key: { id, sk: META },
                  UpdateExpression: "ADD upvotes :du, downvotes :dd SET #status = :newStatus, updatedAt = :now",
                  ConditionExpression:
                    "attribute_exists(id) AND upvotes = :expUp AND downvotes = :expDown AND #status = :expStatus",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":du": du,
                    ":dd": dd,
                    ":newStatus": newStatus,
                    ":now": this.clock.now(),
                    ":expUp": meta.upvotes,
                    ":expDown": meta.downvotes,
                    ":expStatus": curStatus,
                  },
                },
              },
            ],
          }),
        );
        return { upvotes: newUp, downvotes: newDown, status: newStatus };
      } catch (err) {
        if ((err as Error).name === "TransactionCanceledException") continue; // raced — re-read & retry
        throw err;
      }
    }
    throw new Error(`generation vote contention exceeded ${MAX_VOTE_ATTEMPTS} attempts for ${id}`);
  }

  async usageStats(): Promise<GenerationStats> {
    // Same single-Scan-over-meta-items precedent as listByStatus — the gallery is a few
    // dozen rows today; revisit with pagination + a GSI once it grows past the 1MB page.
    const res = await this.deps.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: "sk = :meta",
        ExpressionAttributeValues: { ":meta": META },
        ProjectionExpression: "#status, createdAt, clientIp",
        ExpressionAttributeNames: { "#status": "status" },
      }),
    );
    const items = (res.Items ?? []) as Array<{
      status?: string;
      createdAt: number;
      clientIp: string;
    }>;
    return aggregateGenerationStats(
      items.map((i) => ({
        status: i.status ?? "pending",
        createdAtMs: i.createdAt,
        clientIp: i.clientIp,
      })),
    );
  }
}
