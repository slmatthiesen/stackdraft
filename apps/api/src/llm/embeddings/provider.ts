/**
 * Provider-abstracted embedding layer for the semantic learning network.
 *
 * Mirrors the LlmProvider pattern (KTD2/R13): the retrieval pipeline depends only
 * on this interface, so the default Voyage implementation can be swapped for Gemini,
 * a local model, or any other embedder via the factory without touching callers.
 */

/** A single embedding model call. `embed` returns one vector per input text, in order. */
export interface EmbeddingProvider {
  /** Embed one or more texts. Returns dense float vectors (length == `dim`), input order preserved. */
  embed(texts: string[]): Promise<number[][]>;
  /** The model id (e.g. "voyage-3-lite") — recorded per vector so a model swap never mixes spaces. */
  readonly model: string;
}

/** Typed error so the retrieval pipeline can treat embedding failures as non-fatal (skip, don't 500). */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "EmbeddingError";
  }
}
