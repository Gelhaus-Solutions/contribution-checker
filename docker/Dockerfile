# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- build stage ---
FROM base AS build
# .npmrc routes the @hexclave scope to the self-hosted registry (reads are public, no token)
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec prisma generate && pnpm run build

# --- runner stage ---
FROM base AS runner
RUN apk add --no-cache openssl
RUN addgroup -g 1001 -S app && adduser -S app -u 1001

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/next.config.ts ./next.config.ts
# The Temporal worker runs from source via tsx (see the "worker" npm script),
# so the runner needs src/ and tsconfig.json + the path alias config.
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/tsconfig.json ./tsconfig.json

RUN mkdir -p /app/data && chown app:app /app/data

USER app
EXPOSE 3000

# Run migrations, then the web server AND the Temporal worker side by side.
# `concurrently -k` ties their lifecycles: if either exits the container exits,
# so the orchestrator restarts the whole unit (a dead worker must never leave
# the gate silently down).
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec concurrently -k -n web,worker \"pnpm exec next start -H 0.0.0.0 -p 3000\" \"pnpm run worker\""]
