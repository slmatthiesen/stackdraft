/**
 * DynamoDB-backed FeedbackStore. PK=`ip#promptHash` gives the upsert-not-stack
 * semantics for free (a second verdict from the same IP on the same design overwrites
 * the prior one). A `rating-index` GSI (PK rating, SK updatedAt) serves the
 * newest-first operator review query.
 */
import { randomUUID } from "node:crypto";

import { UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import type { FeedbackEntry, FeedbackStats, FeedbackStore } from "../types.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { DynamoDeps } from "./client.js";
import { aggregateFeedbackStats } from "../stats.js";

function pk(ip: string, promptHash: string): string {
  return `${ip}#${promptHash}`;
}

function toEntry(item: Record<string, unknown>): FeedbackEntry {
  return {
    id: item.id as string,
    promptHash: item.promptHash as string,
    description: item.description as string,
    answers: (item.answers as string[] | undefined) ?? [],
    round: item.round as number,
    recommendedTier: item.recommendedTier as string,
    body: (item.body as string | null | undefined) ?? null,
    rating: item.rating as 1 | -1,
    ip: item.ip as string,
    comment: (item.comment as string | null | undefined) ?? null,
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number,
  };
}

export class DynamoFeedbackStore implements FeedbackStore {
  constructor(
    private readonly deps: DynamoDeps,
    private readonly clock: Clock = systemClock,
  ) {}

  private get table(): string {
    return this.deps.table("feedback");
  }

  async upsert(entry: Omit<FeedbackEntry, "id" | "createdAt" | "updatedAt">): Promise<FeedbackEntry> {
    const now = this.clock.now();
    // On conflict (same ip+promptHash) update rating/tier/body/comment/updatedAt only;
    // preserve id/createdAt and the original description/answers/round/ip via
    // if_not_exists — mirrors the SQLite UNIQUE(ip, prompt_hash) UPSERT.
    const res = await this.deps.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: pk(entry.ip, entry.promptHash) },
        UpdateExpression:
          "SET #id = if_not_exists(#id, :id), #promptHash = if_not_exists(#promptHash, :promptHash), " +
          "#description = if_not_exists(#description, :description), #answers = if_not_exists(#answers, :answers), " +
          "#round = if_not_exists(#round, :round), #ip = if_not_exists(#ip, :ip), " +
          "#createdAt = if_not_exists(#createdAt, :now), " +
          "#rating = :rating, #recommendedTier = :recommendedTier, #body = :body, " +
          "#comment = :comment, #updatedAt = :now",
        ExpressionAttributeNames: {
          "#id": "id",
          "#promptHash": "promptHash",
          "#description": "description",
          "#answers": "answers",
          "#round": "round",
          "#ip": "ip",
          "#createdAt": "createdAt",
          "#rating": "rating",
          "#recommendedTier": "recommendedTier",
          "#body": "body",
          "#comment": "comment",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":id": randomUUID(),
          ":promptHash": entry.promptHash,
          ":description": entry.description,
          ":answers": entry.answers,
          ":round": entry.round,
          ":ip": entry.ip,
          ":now": now,
          ":rating": entry.rating,
          ":recommendedTier": entry.recommendedTier,
          ":body": entry.body,
          ":comment": entry.comment,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return toEntry(res.Attributes as Record<string, unknown>);
  }

  async listByRating(rating: 1 | -1, limit: number): Promise<FeedbackEntry[]> {
    const res = await this.deps.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "rating-index",
        KeyConditionExpression: "#rating = :rating",
        ExpressionAttributeNames: { "#rating": "rating" },
        ExpressionAttributeValues: { ":rating": rating },
        ScanIndexForward: false, // newest updatedAt first
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map(toEntry);
  }

  async usageStats(): Promise<FeedbackStats> {
    const res = await this.deps.doc.send(
      new ScanCommand({
        TableName: this.table,
        ProjectionExpression: "rating, createdAt",
      }),
    );
    const items = (res.Items ?? []) as Array<{ rating: number; createdAt: number }>;
    return aggregateFeedbackStats(items.map((i) => ({ rating: i.rating, createdAtMs: i.createdAt })));
  }
}
