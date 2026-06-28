# Deploying Drafture

Drafture ships as a **single Docker container** (R12): the Fastify API serves the
built React SPA and exposes `/api/*`, with SQLite persisted on a mounted volume so
memory, pricing, response cache, and the spend ledger survive redeploys. The hosted
demo runs on **DigitalOcean** behind **Cloudflare**.

This runbook covers: local build/run, the two DigitalOcean paths, the Cloudflare front,
the optional demo access gate, the monthly pricing-refresh task, and day-to-day ops.

> Secrets live in env only and are **never committed**. The repo tracks `.env.example`
> (placeholders) and nothing else. `.env`, `*.db`, and build artifacts are git-ignored.
> See `.env.example` for the full key list and forker-safe defaults.

---

## 1. Build & run locally

Requires Docker (with Compose). From the repo root:

```bash
cp .env.example .env
```

Set at least `ANTHROPIC_API_KEY` in `.env`; every other value ships with a forker-safe
default. Then:

```bash
docker compose up --build
```

This builds the multi-stage image and starts the app on port **8080** with a named
volume (`drafture-data`) mounted at `/app/data`. Verify:

```bash
curl -s http://localhost:8080/api/health
```

Expect `{"status":"ok","version":"...","uptimeSec":...}`. Open
<http://localhost:8080/> — the SPA loads and a generation runs end-to-end (with a valid
key). Stop with `Ctrl-C`; data persists in the volume across restarts.

To build the image without Compose:

```bash
docker build -t drafture:latest .
docker run --rm -p 8080:8080 --env-file .env -v drafture-data:/app/data drafture:latest
```

---

## 2. DigitalOcean

Single-container model (R12): one image serves SPA + API; SQLite on a mounted volume is
the entire datastore. Pick one of the two paths below.

### 2a. Droplet with Docker (most control, cheapest)

1. Create a small Droplet (the **Docker** Marketplace image, or any Ubuntu LTS with
   Docker + Compose installed). A 1 vCPU / 1 GB box is enough for V1.
2. Copy the repo (or just `docker-compose.yml`) to the Droplet, and create `.env`
   **on the host** — never commit it, never bake it into the image:

   ```bash
   scp .env root@<droplet-ip>:/opt/drafture/.env
   ```

3. Build and run (Compose handles the named volume):

   ```bash
   docker compose up -d --build
   ```

   Or, if you build/push the image elsewhere (registry), pull and run directly:

   ```bash
   docker run -d --restart unless-stopped -p 8080:8080 --env-file /opt/drafture/.env -v drafture-data:/app/data --name drafture <registry>/drafture:latest
   ```

4. The SQLite file lives at `/app/data/drafture.db` **inside the container**, backed
   by the `drafture-data` Docker volume on the host — it persists across
   `docker compose up -d --build` redeploys.
5. Point Cloudflare at the Droplet's public IP (section 3). Keep `8080` reachable only
   from Cloudflare if you want to force edge traffic (firewall rule allowing Cloudflare
   IP ranges); the app guards still hold even direct-to-origin.

### 2b. App Platform (managed, less ops)

1. Deploy as a **container** component (point App Platform at this repo's Dockerfile, or
   a pre-built image in a registry).
2. Set the **HTTP port to `8080`** to match `EXPOSE`/`PORT`.
3. Attach a **volume** for SQLite and mount it at `/app/data` so the database persists
   across deploys. (Without a persistent volume, every redeploy starts with an empty DB
   — the seed KB/pricing re-seed on boot, but memory/cache/ledger history is lost.)
4. Set env vars in the App Platform dashboard (`ANTHROPIC_API_KEY` required; the rest as
   needed — see `.env.example`). Do **not** commit them.
5. App Platform terminates TLS and gives you a public hostname; put Cloudflare in front
   of that hostname (section 3).

> Either path: `DB_PATH=/app/data/drafture.db` is already set in the image, and SQLite
> on the mounted volume is what makes memory/pricing/cache/ledger survive redeploys.

---

## 3. Cloudflare front

Cloudflare (free tier) sits in front of the DigitalOcean origin for edge rate-limiting
and an optional bot check. **It is defense-in-depth, not the cost guarantee** — the
app-level guards (per-IP rate limit + per-IP daily cap + token caps + the $5/day global
ceiling) bound the worst-case bill even if someone hits the origin directly.

1. **Proxy the origin (orange-cloud).** Add a DNS record for your hostname pointing at
   the Droplet IP (path 2a) or the App Platform hostname (path 2b), with the proxy
   (orange cloud) **on**. Cloudflare now terminates TLS and fronts all traffic.
2. **Rate-limiting rule.** Add a Rate Limiting rule (e.g. on `/api/generate`) to shed
   abusive bursts at the edge before they reach the origin. This complements — does not
   replace — the app's per-IP guards.
3. **Optional Turnstile bot check.** Create a Turnstile widget; wire the keys:
   - `TURNSTILE_SITE_KEY` → the frontend widget (rendered on the generate form).
   - `TURNSTILE_SECRET` → the backend env. When the secret is set, the app verifies the
     token server-side and rejects missing/invalid tokens; when unset, the check is off.
4. **Real client IP.** The app trusts the proxy (`trustProxy: true`) and keys the per-IP
   rate limit and per-IP daily cap on **`CF-Connecting-IP`** when present. No extra
   config is needed; just keep the origin behind Cloudflare so that header is set. If
   you want to *force* edge traffic, firewall the origin to Cloudflare's IP ranges.

---

## 4. Hosted-demo access gate (optional)

To put the public demo behind light friction on top of Turnstile + rate limits + the
daily ceiling, enable the shared-credential HTTP basic-auth gate (KTD8). Set **both** of
these in the host/dashboard env (env-only, **never committed**):

```
ACCESS_GATE_USER=<demo-user>
ACCESS_GATE_PASS=<demo-pass>
```

When both are set, every request requires basic-auth creds (401 otherwise). When unset
(the default), the gate is **off** so local and forked instances run open. The gate is
friction against drive-by bots, not the cost guarantee — the per-IP cap + token caps +
$5/day ceiling are what actually bound spend.

---

## 5. Monthly pricing refresh (separate scheduled task)

Pricing estimates read from the cached `PricingStore`; a request **never** blocks on a
live pricing call. The refresh pulls AWS's **public Bulk offer files**, which are large
(hundreds of MB, stream-parsed). Run it **outside** the request-serving container so a
big refresh can't starve the live app.

The refresh job runs via `tsx` against the source (`apps/api/jobs/refreshPricing.ts`) and
is **not** compiled into the runtime image (which prunes devDeps). Run it from the
**build stage** image, which has source + tsx + devDeps, against the **same data
volume**:

```bash
docker build --target build -t drafture:build .
docker run --rm -v drafture-data:/app/data --env-file .env drafture:build pnpm --filter @drafture/api refresh-pricing
```

Schedule that command monthly with whatever fits your platform:

- **Droplet:** a host cron entry (e.g. `0 3 1 * *`, matching `PRICING_REFRESH_CRON`) that
  runs the one-off `docker run` above.
- **App Platform:** a scheduled job / function component running the same one-off
  container against the attached volume.

The refresh is **safe to miss**: the seed pricing facts (`packages/kb/pricing-facts.seed.json`)
are the offline fallback and fully cover V1, and a failed refresh **never partial-wipes**
the cache — the prior month's prices stand until a successful replace. So a skipped or
failed refresh degrades gracefully; it never breaks live requests.

---

## 6. Operational notes

**Where the data lives.** Everything is one SQLite file at
`/app/data/drafture.db` inside the container, backed by the `drafture-data` volume on
the host. It holds the memory store (incl. quarantined research facts), the response
cache, the pricing cache, and the spend ledger.

**Back it up.** SQLite is a single file — copy it from the volume. Example (Droplet):

```bash
docker run --rm -v drafture-data:/app/data -v "$PWD":/backup alpine sh -c "cp /app/data/drafture.db /backup/drafture-$(date +%F).db"
```

(For a hot copy under load, prefer `sqlite3 .backup` over a raw `cp`.) Store backups off
the Droplet.

**Review research-on-miss quarantined facts.** Facts discovered via research-on-miss are
stored `verified:false` and flagged "unverified" in output until you promote them. Run
the CLI on the host (against the same DB / volume):

```bash
docker run --rm -v drafture-data:/app/data --env-file .env drafture:build pnpm --filter @drafture/api list-pending-facts
docker run --rm -v drafture-data:/app/data --env-file .env drafture:build pnpm --filter @drafture/api verify-fact <id>
```

(`verify-fact <id> --reject` deletes a bad fact.) These run via `tsx` so use the
`drafture:build` image, same as the refresh job. There is no admin HTTP surface in V1 —
review happens on the host with DB access.

**Cost levers.** The worst-case bill is bounded by, in order of impact:

| Lever | Env var | Default |
|-------|---------|---------|
| Global daily spend ceiling | `DAILY_SPEND_CEILING_USD` | `5` |
| Per-IP daily generation cap | `PER_IP_DAILY_GENERATIONS` | `20` |
| Identical-prompt response cache | `RESPONSE_CACHE_TTL_MS` | `86400000` (24h) |
| Per-IP rate limit | `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `30` / `60000` |
| Output / input token caps | `LLM_MAX_TOKENS` / `LLM_MAX_INPUT_TOKENS` | `8000` / `12000` |

When the ceiling is hit, new generations are refused with a friendly message and the
tool serves **cache-only** for the rest of the day; cached hits never count against the
ceiling or the per-IP cap. Raise the ceiling with one env change once real Sonnet spend
is observed.
