/**
 * Retrieval calibration eval — the adjust→test→adjust loop for the semantic learning
 * network. Sibling to the golden-set runner: that gates generation QUALITY, this gates
 * retrieval THRESHOLDS.
 *
 * Embeds a labeled query set (paraphrases with a known target id + true negatives),
 * ranks the live corpus, and reports: top-1 ranking accuracy, the cosine separation
 * between true matches and unrelated noise, and an F1 GROUND-threshold sweep. The
 * tracked outputs are the separation gap and the F1-optimal threshold — re-run after
 * the corpus grows or EMBEDDING_MODEL changes, then set the SEMANTIC_*_THRESHOLD
 * defaults from the data instead of guessing.
 *
 * Model-agnostic: runs against whatever model the corpus is currently embedded under,
 * so the SAME eval compares voyage-3-lite vs voyage-3.5 etc. (re-backfill --force to
 * switch the corpus's model first; vectors are keyed by design id, one model at a time).
 *
 * Run:  pnpm --filter @drafture/api eval:retrieval
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getConfig } from "../config.js";
import { getDb } from "../store/sqlite.js";
import { buildEmbeddingProvider } from "../llm/embeddings/factory.js";
import { cosineSimilarity as cosine, blobToVector } from "../store/vectorMath.js";

interface Labeled {
  /** Corpus id a paraphrase SHOULD match; null = true negative (must not serve/ground). */
  target: string | null;
  text: string;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const { queries } = JSON.parse(readFileSync(join(here, "retrievalQueries.json"), "utf8")) as {
    queries: Labeled[];
  };

  const config = getConfig();
  const embedder = buildEmbeddingProvider(config);
  if (!embedder) {
    console.error("No embedder configured — set EMBEDDING_PROVIDER=voyage and VOYAGE_API_KEY.");
    process.exit(1);
  }

  const db = getDb(config.DB_PATH);
  const corpus = (
    db.prepare("SELECT id, vector FROM design_embeddings WHERE model = ?").all(embedder.model) as {
      id: string;
      vector: Buffer;
    }[]
  ).map((r) => ({ id: r.id, vec: blobToVector(r.vector) }));
  if (corpus.length === 0) {
    console.error(`Corpus is empty under ${embedder.model}. Run backfillEmbeddings.ts first.`);
    process.exit(1);
  }
  console.log(`Model ${embedder.model} · corpus ${corpus.length} · queries ${queries.length}\n`);

  const qvecs = await embedder.embed(queries.map((q) => q.text));

  interface Scored {
    q: Labeled;
    targetSim: number | null;
    top: { id: string; sim: number };
    bestWrongSim: number;
  }
  const scored: Scored[] = queries.map((q, i) => {
    const ranked = corpus
      .map((c) => ({ id: c.id, sim: cosine(qvecs[i]!, c.vec) }))
      .sort((a, b) => b.sim - a.sim);
    const top = ranked[0]!;
    const targetSim = q.target ? (ranked.find((r) => r.id === q.target)?.sim ?? null) : null;
    const bestWrong = ranked.find((r) => r.id !== q.target)!; // best match that is NOT the target
    return { q, targetSim, top, bestWrongSim: bestWrong.sim };
  });

  // --- Ranking quality (threshold-independent) ---
  const positives = scored.filter((s) => s.q.target !== null);
  const negatives = scored.filter((s) => s.q.target === null);
  const top1Correct = positives.filter((s) => s.top.id === s.q.target).length;
  console.log(
    `Top-1 ranking accuracy (positives): ${top1Correct}/${positives.length} = ${((100 * top1Correct) / positives.length).toFixed(0)}%`,
  );

  const meanTargetSim = positives.reduce((a, s) => a + (s.targetSim ?? 0), 0) / positives.length;
  const meanNegBest = negatives.reduce((a, s) => a + s.bestWrongSim, 0) / negatives.length;
  const maxNegBest = Math.max(...negatives.map((s) => s.bestWrongSim));
  console.log(`Mean cosine — true target (positives): ${meanTargetSim.toFixed(3)}`);
  console.log(`Mean cosine — best match (negatives) : ${meanNegBest.toFixed(3)}   ← noise floor`);
  console.log(`Separation gap: ${(meanTargetSim - meanNegBest).toFixed(3)}\n`);

  // The hard cases: a positive the model mis-ranks or scores below the noise floor.
  const hard = positives.filter(
    (s) => s.top.id !== s.q.target || (s.targetSim ?? 0) < meanNegBest,
  );
  if (hard.length) {
    console.log("Hard cases (mis-ranked or target below noise floor):");
    for (const s of hard) {
      console.log(
        `  target=${s.q.target} sim=${(s.targetSim ?? 0).toFixed(3)} · top=${s.top.id}(${s.top.sim.toFixed(3)}) · "${s.q.text.slice(0, 50)}…"`,
      );
    }
    console.log();
  }

  // --- GROUND sweep: gate fires iff top match >= thr.
  //   true positive  = positive whose top match IS the target and clears thr
  //   false positive = negative whose top match clears thr (noise leaks in)
  console.log("GROUND sweep:");
  console.log("  thr   | recall | neg false-fires | precision | F1");
  let best = { thr: 0, f1: -1, recall: 0, prec: 0, fp: 0 };
  for (let thr = 0.55; thr <= 0.92; thr += 0.025) {
    const tp = positives.filter((s) => s.top.id === s.q.target && s.top.sim >= thr).length;
    const posFires = positives.filter((s) => s.top.sim >= thr).length;
    const fp = negatives.filter((s) => s.top.sim >= thr).length;
    const recall = tp / positives.length;
    const precision = posFires + fp > 0 ? tp / (posFires + fp) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { thr, f1, recall, prec: precision, fp };
    console.log(
      `  ${thr.toFixed(3)} |  ${recall.toFixed(2)}  |      ${fp}/${negatives.length}        |   ${precision.toFixed(2)}    | ${f1.toFixed(3)}`,
    );
  }
  console.log(
    `\nF1-optimal GROUND ≈ ${best.thr.toFixed(3)} (recall ${best.recall.toFixed(2)}, precision ${best.prec.toFixed(2)}, ${best.fp} noise fires).`,
  );
  console.log(
    `RETURN (instant-serve) should sit a clear margin above the noise ceiling (max negative best-sim = ${maxNegBest.toFixed(3)}).`,
  );

  db.close();
}

void main();
