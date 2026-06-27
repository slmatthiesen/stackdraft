# Contributing to Stackdraft

Thanks for your interest. This is an open-source showcase project, and contributions — bug reports, fixes, docs, and features — are welcome. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node 22**
- **pnpm 10.5.0** (`corepack enable` then `corepack use pnpm@10.5.0`)

## Setup

```bash
git clone https://github.com/slmatthiesen/stackdraft.git
cd stackdraft
pnpm install
cp .env.example .env          # set ANTHROPIC_API_KEY; other defaults are safe
```

`pnpm dev` runs the app locally. The only required variable is `ANTHROPIC_API_KEY`.

## Before you push

Run the same checks CI runs, and get them all green:

```bash
pnpm lint        # eslint .
pnpm typecheck   # pnpm -r typecheck
pnpm test        # pnpm -r test
pnpm build       # pnpm -r build
```

Don't claim a change is done until lint, typecheck, tests, and build all pass.

## Branching

- The default branch is **`main`**. Never push directly to it; open a PR.
- Branch off `main` with a descriptive, type-prefixed name:
  - `feat/<short-desc>` — new functionality
  - `fix/<short-desc>` — bug fix
  - `docs/<short-desc>` — docs only
  - `chore/<short-desc>` / `refactor/<short-desc>` / `test/<short-desc>`

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <summary>

feat(pipeline): add burst-handling notes to budget tier
fix(guards): respect CF-Connecting-IP for per-IP cap
docs(readme): document NAT-gateway cost line
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`. Keep the summary imperative and under ~72 chars; explain the *why* in the body when it isn't obvious.

## Pull requests

1. Open your PR against `main` and fill out the PR template (summary, what & why, testing, checklist).
2. Keep PRs focused — one logical change per PR.
3. Ensure CI is green (lint + typecheck + test + build) and the secret scan passes.
4. Update docs and tests alongside the code change.
5. A maintainer will review; address feedback by pushing follow-up commits to the same branch.

## Secret hygiene (non-negotiable)

This repo models the safe-by-default posture the tool recommends:

- **Never commit `.env`, real API keys, tokens, or any secret.** Only `.env.example` (placeholders) is tracked. `.env`, `*.db`, `dist/`, and `node_modules/` are git-ignored.
- Secrets load from environment at runtime and must be redacted in logs and error responses — never log a key or `.env` contents.
- A gitleaks secret-scan workflow runs on every push and PR. If it flags your branch, **rotate the exposed credential immediately** (assume it's compromised) and scrub it from history before re-pushing.
- Keep config defaults forker-safe: a clone must not be able to run up a bill (conservative spend ceiling, rate limits on by default).
