# syntax=docker/dockerfile:1.7

# Debian (glibc), NOT alpine: Temporal's native core-bridge ships a glibc
# prebuild (x86_64-unknown-linux-gnu) that needs ld-linux-x86-64.so.2, which
# musl/alpine lacks. glibc is also Temporal's officially supported target.
FROM node:24-slim AS base
# pnpm keeps its content-addressable store under $PNPM_HOME/store. Pointing it
# at a stable path lets the BuildKit cache mounts below persist downloaded
# packages (incl. the large @temporalio native core-bridge) across builds, so a
# webhook-triggered rebuild no longer re-downloads the whole dependency tree.
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# --- build stage: full deps, compiles Next + Prisma client ---
FROM base AS build
# git is used only to derive the Worker Deployment Build ID from the checkout.
# Installed before the source COPY so this layer stays cached across commits.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# Derive the Build ID: the 6-char commit sha, automatically. Override by passing
# --build-arg BUILD_ID=<value> (e.g. a version tag); falls back to "dev" if no
# git checkout is present in the build context.
ARG BUILD_ID=""
RUN git config --global --add safe.directory /app \
    && printf '%s' "${BUILD_ID:-$(git rev-parse --short=6 HEAD 2>/dev/null || echo dev)}" > /app/.build-id \
    && echo "Worker Build ID: $(cat /app/.build-id)"
ENV NEXT_TELEMETRY_DISABLED=1
# Persist Next.js's webpack cache across builds for much faster rebuilds.
# build:worker bundles the Temporal worker to dist/worker.mjs (esbuild) — a
# single self-contained ESM module, so the runtime needs no tsx/path-alias
# resolution and avoids the Node 24 require(esm) cycle the raw .ts graph hits.
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache \
    pnpm exec prisma generate && pnpm run build && pnpm run build:worker

# --- prod-deps stage: runtime-only node_modules (no vitest/playwright/eslint/
#     typescript/esbuild/tsx/@temporalio/testing), keeping the image small.
#     prisma is a runtime dep (migrations); the worker ships pre-bundled so no
#     tsx is needed at runtime. The Prisma client is generated here. ---
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile
COPY prisma ./prisma
RUN pnpm exec prisma generate

# --- runner stage ---
FROM base AS runner
LABEL org.opencontainers.image.title="contribution-checker" \
      org.opencontainers.image.vendor="Gelhaus Solutions" \
      org.opencontainers.image.authors="Enno Gelhaus <egelhaus@ennogelhaus.de>" \
      org.opencontainers.image.url="https://ennogelhaus.de" \
      org.opencontainers.image.source="https://gitlab.ennogelhaus.de/gelhaus-corp/contribution-checker" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
# openssl + ca-certificates for Prisma (and outbound TLS); procps so
# `concurrently -k` can `ps` the process tree on shutdown (node:slim omits it).
# Debian useradd/groupadd replace the busybox addgroup/adduser flags.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 app \
    && useradd -u 1001 -g app -m -s /usr/sbin/nologin app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Slim runtime node_modules (prod-only) + the Next build output from the build
# stage. This drops dev-only packages (and @temporalio/testing's test-server
# binary) from the image, cutting its size and push/pull time.
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/next.config.ts ./next.config.ts
# Pre-bundled worker (dist/worker.mjs). The worker itself is self-contained, but
# Temporal compiles the *workflow* code from source at runtime (workflowsPath),
# so src/ (worker/workflows + lib/temporal/contracts) and tsconfig.json ship too.
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/tsconfig.json ./tsconfig.json
# The derived Build ID (6-char commit sha). Read into TEMPORAL_BUILD_ID at start.
COPY --from=build --chown=app:app /app/.build-id ./.build-id

RUN mkdir -p /app/data && chown app:app /app/data

USER app
EXPOSE 3000

# Export the baked Build ID, run migrations, then the web server AND the Temporal
# worker side by side. `concurrently -k` ties their lifecycles: if either exits
# the container exits, so the orchestrator restarts the whole unit (a dead worker
# must never leave the gate silently down).
CMD ["sh", "-c", "export TEMPORAL_BUILD_ID=\"$(cat /app/.build-id 2>/dev/null || echo dev)\" && pnpm exec prisma migrate deploy && pnpm exec concurrently -k -n web,worker \"pnpm exec next start -H 0.0.0.0 -p 3000\" \"pnpm run worker\""]
