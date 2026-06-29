/**
 * Select the embedding provider from config — the one place that knows which
 * concrete embedder backs the EmbeddingProvider interface.
 *
 * Returns `null` (not throws) when retrieval is disabled or unconfigured, so the
 * learning network degrades to "off" without breaking generation. Forker-safe:
 * EMBEDDING_PROVIDER=voyage with no VOYAGE_API_KEY → null + a one-line warning.
 */
import type { Config } from "../../config.js";
import type { EmbeddingProvider } from "./provider.js";
import { VoyageEmbeddingProvider } from "./voyage.js";

export function buildEmbeddingProvider(
  config: Config,
  fetchFn?: typeof fetch,
): EmbeddingProvider | null {
  if (config.EMBEDDING_PROVIDER === "none") return null;
  if (config.EMBEDDING_PROVIDER === "voyage") {
    const provider = VoyageEmbeddingProvider.fromConfig(config, fetchFn);
    if (!provider) {
      console.warn(
        "[embeddings] EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is unset — semantic learning network disabled.",
      );
    }
    return provider;
  }
  return null;
}
