import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

/**
 * Centralized, validated runtime configuration (12-factor).
 *
 * Defaults are deliberately FORKER-SAFE (R15/KTD10): a clone that runs without
 * tuning anything is protected before it sets a single value — low daily spend
 * ceiling, low per-IP cap, rate limiting on, bot check honored when keys exist.
 * Secrets are read from env only and never logged (see obs/telemetry redaction).
 */
const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["1", "0", "true", "false", "yes", "no", "on", "off"]))
  .transform((v) => ["1", "true", "yes", "on"].includes(v));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),

  // LLM
  ANTHROPIC_API_KEY: z.string().optional(),

  // Provider selection (KTD2): "claude" (Anthropic, default) or "glm" (Zhipu /
  // BigModel, OpenAI-compatible). The selected provider's key is required
  // (enforced below), so a GLM-only deploy needs no Anthropic key.
  LLM_PROVIDER: z.enum(["claude", "glm"]).default("claude"),
  GLM_API_KEY: z.string().optional(),
  GLM_BASE_URL: z.string().default("https://open.bigmodel.cn/api/paas/v4"),
  LLM_MODEL: z.string().default("claude-sonnet-4-6"),
  // Medium by default: at `low`, the model repeatedly flaked on the output schema
  // (e.g. emitting `rationative` for `keyDecisions[].rationale`), failing validation
  // and 502-ing. The system prompt is detailed; medium follows it reliably for a
  // modest latency/cost premium. Override per-deploy with LLM_EFFORT if needed.
  LLM_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  // Headroom so a full three-tier design never truncates (truncation → parse
  // failure → retry → multi-minute latency). The conciseness directive in the
  // system prompt keeps actual output well under this.
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(14000),
  LLM_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(12000),

  // Per-MTok USD list-price rates used to convert token usage to dollars for the
  // spend ledger + telemetry. Defaults are Sonnet-class on-demand list prices;
  // override when the model or negotiated pricing changes. Approximate by design
  // (the ledger reconciles actuals; the guard stays conservative).
  LLM_PRICE_INPUT_PER_MTOK: z.coerce.number().nonnegative().default(3),
  LLM_PRICE_OUTPUT_PER_MTOK: z.coerce.number().nonnegative().default(15),
  LLM_PRICE_CACHE_WRITE_PER_MTOK: z.coerce.number().nonnegative().default(3.75),
  LLM_PRICE_CACHE_READ_PER_MTOK: z.coerce.number().nonnegative().default(0.3),

  // Semantic learning network (RAG over our own approved designs). Embeddings are
  // provider-abstracted (EmbeddingProvider) — Voyage by default; "none" disables
  // retrieval entirely (the generate path still works, just without instant-serve
  // or semantic grounding). Forker-safe: a clone with no VOYAGE_API_KEY degrades to
  // "none" at boot rather than failing — the learning network is an enhancement, not
  // a hard dependency.
  EMBEDDING_PROVIDER: z.enum(["voyage", "none"]).default("voyage"),
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_BASE_URL: z.string().default("https://api.voyageai.com/v1"),
  EMBEDDING_MODEL: z.string().default("voyage-3-lite"),
  // Cosine ≥ RETURN → serve the nearest approved design verbatim (re-costed), $0 +
  // instant. GROUND ≤ cosine < RETURN → inject the nearest designs as exemplars into
  // the generation prompt (faster convergence, more consistent).
  // Defaults CALIBRATED against scripts/eval/retrievalEval.ts on voyage-3-lite: a
  // labeled paraphrase/negative set ranks top-1 at 100%, with true matches ~0.78 and
  // the unrelated noise floor ~0.52 (max 0.68). GROUND 0.70 → precision 1.0 / recall
  // 0.94 (no noise fires); RETURN 0.80 sits a clear margin above the noise floor so
  // only near-identical prompts short-circuit (and top-1 accuracy means they're the
  // right design). Re-run the eval after the corpus grows or the embed model changes.
  SEMANTIC_RETURN_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  SEMANTIC_GROUND_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  SEMANTIC_GROUND_TOPK: z.coerce.number().int().positive().default(2),

  // Region / pricing
  DEFAULT_REGION: z.string().default("us-east-1"),
  PRICING_REFRESH_CRON: z.string().default("0 3 1 * *"),

  // Cost + abuse controls (R11). Tight by default: this is a self-funded public
  // demo, so each visitor gets a small daily allotment of (expensive) full
  // generations. The daily cap is the real "a couple per visitor per day" lever;
  // the rate limit only stops bursts and must stay high enough to open the
  // Terraform panel across all three tiers in one sitting (1 generate + 3 config).
  DAILY_SPEND_CEILING_USD: z.coerce.number().positive().default(5),
  PER_IP_DAILY_GENERATIONS: z.coerce.number().int().positive().default(2),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RESPONSE_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  // Bot check (Cloudflare Turnstile) — enabled only when secret is set
  TURNSTILE_SECRET: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),

  // Optional shared-credential demo access gate — off when unset (KTD8)
  ACCESS_GATE_USER: z.string().optional(),
  ACCESS_GATE_PASS: z.string().optional(),

  // Research-on-miss (KTD4/U6) — off by default; bounded when on
  RESEARCH_ON_MISS: boolish.default("false"),
  RESEARCH_MAX_CALLS_PER_REQUEST: z.coerce.number().int().nonnegative().default(2),

  // Persistence / public gallery: every real generation is stored permanently as the
  // backbone for the browsable gallery + model/template improvement. Off in test and
  // probe environments so they never pollute the store with throwaway runs.
  PERSIST_GENERATIONS: boolish.default("true"),
  // Net (upvotes - downvotes) at or below which an APPROVED generation is auto-hidden
  // back into the review queue — community-driven removal, hard-delete stays manual.
  GENERATION_HIDE_NET_VOTES: z.coerce.number().int().default(-3),

  // Storage
  DB_PATH: z.string().default("./data/drafture.db"),

  // Static SPA build directory served by the API
  WEB_DIST: z.string().default("../web/dist"),
}).superRefine((v, ctx) => {
  // Fail fast at config load if the SELECTED provider's key is missing. Keeps
  // forker-safe behavior (a bare clone still can't boot without a real key) while
  // allowing a GLM-only deploy to omit ANTHROPIC_API_KEY.
  if (v.LLM_PROVIDER === "claude" && !v.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ANTHROPIC_API_KEY"],
      message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude",
    });
  }
  if (v.LLM_PROVIDER === "glm" && !v.GLM_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GLM_API_KEY"],
      message: "GLM_API_KEY is required when LLM_PROVIDER=glm",
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

/** Parse + validate process env. Fails fast with a clear message (U1 error path). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Best-effort load of the nearest `.env` by walking up from the process CWD.
 * `tsx` (`pnpm dev`) and a bare `node` don't load `.env` (the built-server path
 * uses `--env-file`), so without this `pnpm dev` can't see ANTHROPIC_API_KEY and
 * fails fast. Never overrides vars already in the environment — real env /
 * `--env-file` / inline shell always win. `.env` is gitignored, so a production
 * deploy with real env vars (no `.env` file) is unaffected (no-op).
 */
function loadEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    let text: string;
    try {
      text = readFileSync(resolve(dir, ".env"), "utf8");
    } catch {
      const parent = resolve(dir, "..");
      if (parent === dir) return undefined; // filesystem root — no .env found
      dir = parent;
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      if (key in process.env) continue; // don't clobber real env / --env-file
      let value = match[2]!;
      value = value.replace(/\s+#.*$/, ""); // trailing inline comment
      value = value.replace(/^["']|["']$/g, ""); // surrounding quotes
      process.env[key] = value;
    }
    return dir; // first .env found wins — this is the repo root
  }
  return undefined;
}

/**
 * Anchor a RELATIVE DB_PATH to the repo root, not the process CWD. `pnpm dev` runs
 * tsx from `apps/api` while the curated gallery is seeded from the repo root, so a
 * cwd-relative `./data/drafture.db` resolved to TWO different files (an empty one
 * under apps/api, the seeded one at the root) and the gallery came up empty. Pin a
 * relative path to the discovered repo root so every entry point opens the SAME DB.
 * Absolute paths and production (real env, no `.env`) are untouched.
 */
function anchorDbPath(repoRoot: string | undefined): void {
  if (!repoRoot) return;
  const dbPath = process.env.DB_PATH ?? "./data/drafture.db";
  if (isAbsolute(dbPath)) return;
  process.env.DB_PATH = resolve(repoRoot, dbPath);
}

export function getConfig(): Config {
  if (!cached) {
    const repoRoot = loadEnvFile();
    anchorDbPath(repoRoot);
    cached = loadConfig();
  }
  return cached;
}

/** Test helper: reset the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
