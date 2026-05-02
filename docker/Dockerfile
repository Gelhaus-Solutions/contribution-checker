FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- deps stage ---
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false

# --- build stage ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Generate Prisma client + build Next.js standalone bundle
RUN pnpm exec prisma generate && pnpm run build

# --- runner stage ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S app && adduser -S app -u 1001
RUN apk add --no-cache openssl

# Standalone Next.js server + assets
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# Prisma needs the schema + the libquery-engine binary at runtime
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=app:app /app/node_modules/prisma ./node_modules/prisma

RUN mkdir -p /app/data && chown -R app:app /app/data

USER app
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run pending migrations on startup, then launch.
CMD sh -c "node node_modules/prisma/build/index.js migrate deploy && node server.js"
