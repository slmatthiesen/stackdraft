# Pre-publish secret & security audit (U14)

The hard gate before this repository is made public. Verifies no secrets are in
the working tree **or git history**, that defaults are forker-safe, and that
dependencies are clean. Re-run this checklist before any `git push` to a public
remote.

**Status: ✅ PASS** — audited at commit on `feat/drafture-v1` (date: 2026-06-26).

## How to re-run

```
# Full git-history secret scan (what a public clone exposes)
docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml
# Working-tree scan (also sees gitignored files like a local .env)
docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:latest detect --source /repo --config /repo/.gitleaks.toml --no-git
# Dependency advisories
pnpm audit --prod
```

(On Git Bash for Windows, prefix the `docker run` lines with `MSYS_NO_PATHCONV=1` so `/repo` isn't path-mangled.)

## Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | **Full git-history secret scan** (gitleaks, 8 commits) | ✅ `no leaks found` |
| 2 | **Only `.env.example` tracked** — no `.env`, no `*.db` | ✅ `git ls-files` shows only `.env.example` |
| 3 | **No live keys in tracked tree** (`sk-ant-…`, `ANTHROPIC_API_KEY=<value>`) | ✅ only `REPLACE_ME` / test placeholders |
| 4 | **Local `.env` is ignored & unstaged** | ✅ `git check-ignore .env` hits; not tracked, not staged |
| 5 | **Logs/errors redact secrets** | ✅ Fastify logger `redact` covers auth/cookie/API-key paths; config is never logged; the API key is read from env only |
| 6 | **Forker-safe defaults** | ✅ `DAILY_SPEND_CEILING_USD=5`, `PER_IP_DAILY_GENERATIONS=20`, rate limit on (`30/min`), `RESEARCH_ON_MISS=false`, access gate off, no real keys in `.env.example` |
| 7 | **Dependency advisories** (`pnpm audit --prod`) | ✅ `No known vulnerabilities found` (after bumping `@fastify/static` → `^9.1.3`, which closes two moderate path-traversal / route-guard-bypass advisories) |
| 8 | **License present** | ✅ `LICENSE` = MIT |
| 9 | **Positive control — the scanner actually fires** | ✅ the working-tree scan detected a real key in the local (gitignored) `.env`, confirming the `anthropic-api-key` rule works |

## Notes & accepted findings

- **Real key in local `.env` (expected, safe).** The working-tree scan (`--no-git`)
  flagged a live Anthropic key inside `.env`. That file is **gitignored, untracked,
  and unstaged** — it exists only so the app runs locally and is never committed
  (the history scan is clean). This is the intended posture and doubles as the
  audit's positive control. **Operators must keep `.env` local and never force-add
  it.**
- **Bot check is opt-in, not on-by-default.** KTD10 lists "bot check on by default"
  as a forker-safe goal, but Cloudflare Turnstile cannot run without site/secret
  keys, so it is enabled only when `TURNSTILE_SECRET` is set. The actual cost/abuse
  guarantee for an out-of-the-box clone is the always-on layer: the **$5/day global
  spend ceiling + per-IP daily cap + per-IP rate limit + hard input-token cap**.
  Turnstile and the access gate are defense-in-depth a deployer opts into.
- **History note.** Per the plan U14 intended the first commit to be deferred until
  this gate passed. With the operator's explicit go-ahead, work was committed
  incrementally on `feat/drafture-v1` for safety checkpoints; secret hygiene was
  in place from commit 1 (`.gitignore` excludes `.env`/`*.db`, only `.env.example`
  tracked), so **history is clean by construction** — this gate verifies that
  property rather than relying on a single deferred commit.

## Sign-off

All gate checks pass. The repository is safe to push to a public remote. Re-run
the three commands above before publishing if the tree has changed.
