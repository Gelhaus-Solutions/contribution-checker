import { prisma } from "@/lib/db";

type Bucket = { count: number; windowEnd: number };
const memCache = new Map<string, Bucket>();

const MAX_CACHE_ENTRIES = 5000;

function pruneIfFull() {
  if (memCache.size < MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of memCache) {
    if (v.windowEnd <= now) memCache.delete(k);
  }
  if (memCache.size < MAX_CACHE_ENTRIES) return;
  // Still full, so drop the oldest 10%.
  const drop = Math.floor(MAX_CACHE_ENTRIES * 0.1);
  let i = 0;
  for (const k of memCache.keys()) {
    memCache.delete(k);
    if (++i >= drop) break;
  }
}

/**
 * Fixed-window rate limit. `key` is namespaced by callers (e.g. "apply:user:<id>").
 * Returns whether the request is allowed plus how many slots remain.
 *
 * The window is anchored to the bucket's `windowEnd` so existing in-memory
 * data is reused across requests without a DB read on every call.
 */
export async function rateLimit(args: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<{ ok: boolean; remaining: number; resetAt: Date }> {
  const now = Date.now();
  const cached = memCache.get(args.key);

  if (cached && cached.windowEnd > now) {
    if (cached.count >= args.limit) {
      return {
        ok: false,
        remaining: 0,
        resetAt: new Date(cached.windowEnd),
      };
    }
    cached.count += 1;
    // Fire-and-forget DB sync so the limit survives process restarts.
    void prisma.rateLimitBucket
      .update({
        where: { key: args.key },
        data: { count: cached.count },
      })
      .catch(() => undefined);
    return {
      ok: true,
      remaining: args.limit - cached.count,
      resetAt: new Date(cached.windowEnd),
    };
  }

  // Cache miss or expired: reconcile with DB.
  const windowEnd = now + args.windowMs;
  const existing = await prisma.rateLimitBucket.findUnique({
    where: { key: args.key },
  });

  if (existing && existing.windowEnd.getTime() > now) {
    if (existing.count >= args.limit) {
      memCache.set(args.key, {
        count: existing.count,
        windowEnd: existing.windowEnd.getTime(),
      });
      return {
        ok: false,
        remaining: 0,
        resetAt: existing.windowEnd,
      };
    }
    const updated = await prisma.rateLimitBucket.update({
      where: { key: args.key },
      data: { count: existing.count + 1 },
    });
    memCache.set(args.key, {
      count: updated.count,
      windowEnd: updated.windowEnd.getTime(),
    });
    return {
      ok: true,
      remaining: args.limit - updated.count,
      resetAt: updated.windowEnd,
    };
  }

  // Start a fresh window.
  const created = await prisma.rateLimitBucket.upsert({
    where: { key: args.key },
    update: { count: 1, windowEnd: new Date(windowEnd) },
    create: { key: args.key, count: 1, windowEnd: new Date(windowEnd) },
  });
  pruneIfFull();
  memCache.set(args.key, {
    count: created.count,
    windowEnd: created.windowEnd.getTime(),
  });
  return {
    ok: true,
    remaining: args.limit - created.count,
    resetAt: created.windowEnd,
  };
}
