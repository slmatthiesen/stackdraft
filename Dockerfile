# syntax=docker/dockerfile:1
# Single-container build: SPA is built, then served by the API (one image, R12).

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
# better-sqlite3 needs a toolchain to (re)build native bindings.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/kb/package.json packages/kb/package.json
RUN pnpm install --frozen-lockfile || pnpm install
COPY . .
# Build-time web vars: declared as ARGs and exported to ENV so Vite sees them via
# process.env during `vite build` (VITE_* are compiled INTO the bundle, never read at
# runtime). Sourced from the host .env through docker-compose build.args. Empty/unset →
# the client beacon + Sentry init are no-ops in the shipped SPA.
ARG VITE_SENTRY_DSN
ARG VITE_CF_WEB_ANALYTICS_TOKEN
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_CF_WEB_ANALYTICS_TOKEN=$VITE_CF_WEB_ANALYTICS_TOKEN
RUN pnpm --filter @drafture/web build \
    && pnpm --filter @drafture/api build

FROM base AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/kb/package.json packages/kb/package.json
RUN pnpm install --prod --frozen-lockfile --filter @drafture/api... || pnpm install --prod --filter @drafture/api...
RUN apt-get purge -y g++ make python3 && apt-get autoremove -y
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/kb packages/kb
# The API resolves WEB_DIST relative to its own dir (apps/api/dist) by default,
# which would miss apps/web/dist; pin the absolute path so the SPA is served.
ENV WEB_DIST=/app/apps/web/dist
# SQLite data persists on a mounted volume (U12).
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/drafture.db
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
