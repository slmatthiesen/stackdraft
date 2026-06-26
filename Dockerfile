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
RUN pnpm --filter @stackdraft/web build \
    && pnpm --filter @stackdraft/api build

FROM base AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/kb/package.json packages/kb/package.json
RUN pnpm install --prod --frozen-lockfile --filter @stackdraft/api... || pnpm install --prod --filter @stackdraft/api...
RUN apt-get purge -y g++ make python3 && apt-get autoremove -y
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/kb packages/kb
# SQLite data persists on a mounted volume (U12).
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/stackdraft.db
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
