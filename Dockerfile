# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates git bash util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.17.0
WORKDIR /app

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .npmrc ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# Preflight runs the same source adapters with tsx; no extra global Codex install.
COPY src ./src
COPY scripts ./scripts
COPY workspace-template ./workspace-template
RUN mkdir -p /data/codex /data/topics /data/state /opt/oncall-tools/bin \
    && chown -R node:node /data
ENV NODE_ENV=production \
    HOME=/data \
    CODEX_HOME=/data/codex \
    STATE_DB_PATH=/data/state/bot.db \
    WORKSPACE_ROOT=/data/topics \
    MAX_CONCURRENT_TURNS=5 \
    TURN_TIMEOUT_MS=0 \
    WORKSPACE_RETENTION_DAYS=30 \
    PATH=/opt/oncall-tools/bin:$PATH
USER node
CMD ["node", "dist/main.js"]
