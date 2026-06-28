# Security Policy

## Supported scope

Drafture is an actively developed showcase project. Security fixes are applied to the latest `main`; there are no separately maintained release branches in V1. Please report against current `main`.

The reportable surface includes:

- The Fastify API and its guards (rate limiting, per-IP daily cap, spend ceiling, access gate, Turnstile verification).
- Secret handling — anything that could leak `ANTHROPIC_API_KEY`, gate credentials, or `.env` contents into logs, error responses, the repo, or git history.
- Cost-control bypasses — any path that lets a caller exceed the daily spend ceiling or the per-IP generation cap, or that escapes the input/output token caps.
- Prompt-injection or research-on-miss paths that could poison the trusted KB without operator review.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's **"Report a vulnerability"** flow (repo → **Security** tab → **Advisories** → **Report a vulnerability**), which opens a private security advisory visible only to maintainers.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof-of-concept if possible).
- Affected component / file paths and any relevant configuration.

We aim to acknowledge a report within a few days, confirm the issue, and coordinate a fix and disclosure timeline with you. Please give us a reasonable window to remediate before any public disclosure.

## Safe-by-default posture

Drafture is built to model the practices the tool itself recommends:

- **No secrets in the tree or history.** Only `.env.example` (placeholders) is tracked; `.env`, `*.db`, and build artifacts are git-ignored. A gitleaks scan runs in CI on every push and PR, and a pre-publish audit gated the very first commit.
- **Secrets load from env and are redacted** in logs and error responses.
- **Forker-safe defaults** — a low daily spend ceiling ($5/day), per-IP caps, and rate limiting are on out of the box, so a clone can't accidentally run up a bill before it's tuned.
- **Defense in depth** — the access gate and CAPTCHA are friction; the per-IP cap, token caps, and the transactional reserve-on-entry spend ceiling are the hard cost backstops.

If you find a place where the codebase falls short of this posture, that's a valid report — please send it.
