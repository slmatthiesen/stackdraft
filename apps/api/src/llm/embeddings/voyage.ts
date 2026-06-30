/**
 * Voyage AI embedding provider (Anthropic's recommended embedding partner).
 *
 * Plain HTTPS to the Voyage REST API (`/embeddings`) — there is no first-party
 * Voyage SDK we depend on, and the payload is a single flat JSON shape. Behind the
 * EmbeddingProvider interface, so it's swappable for Gemini / a local model.
 */
import type { Config } from "../../config.js";
import { EmbeddingError, type EmbeddingProvider } from "./provider.js";

/** Voyage caps a single request at 128 inputs; chunk larger batches (the backfill sends many). */
const MAX_BATCH = 128;

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static fromConfig(config: Config, fetchFn?: typeof fetch): VoyageEmbeddingProvider | null {
    if (!config.VOYAGE_API_KEY) return null;
    return new VoyageEmbeddingProvider(
      config.VOYAGE_API_KEY,
      config.VOYAGE_BASE_URL,
      config.EMBEDDING_MODEL,
      fetchFn,
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      out.push(...(await this.embedBatch(texts.slice(i, i + MAX_BATCH))));
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: batch, input_type: "document" }),
      });
    } catch (err) {
      throw new EmbeddingError("Voyage request failed (network)", err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmbeddingError(`Voyage returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as VoyageResponse;
    // The API may return rows out of order; sort by index so output aligns with input.
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
