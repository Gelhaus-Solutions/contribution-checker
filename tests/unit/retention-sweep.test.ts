import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    rateLimitBucket: { deleteMany: vi.fn(async () => ({ count: 3 })) },
    auditEvent: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    aiResult: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/github/reconcile", () => ({
  reconcileProjectClosedPrs: vi.fn(),
  projectIdsWithAppRepos: vi.fn(),
}));
vi.mock("@/lib/cla/notify", () => ({ sweepUnsignedApplicants: vi.fn() }));
vi.mock("@/lib/temporal/start", () => ({
  signalPrReGate: vi.fn(),
  signalProjectSweepTick: vi.fn(),
}));

import { prisma } from "@/lib/db";
import {
  OPERATIONAL_RECORD_RETENTION_MONTHS,
  pruneRetainedRecords,
  retentionCutoff,
} from "@/worker/activities/sweeps";

const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;
const NOW = new Date("2026-10-02T03:30:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the retention period", () => {
  it("is the 24 months the records of processing give audit events and AI results", () => {
    // Decided by the operator on 2026-10-02. Changing it changes what the
    // privacy notice has to say, so it has to fail here first.
    expect(OPERATIONAL_RECORD_RETENTION_MONTHS).toBe(24);
  });
});

describe("retentionCutoff", () => {
  it("goes back whole calendar months in UTC", () => {
    expect(retentionCutoff(NOW, 24).toISOString()).toBe("2024-10-02T03:30:00.000Z");
  });
});

describe("pruneRetainedRecords", () => {
  it("deletes audit events and AI results older than the retention period", async () => {
    await pruneRetainedRecords();
    const cutoff = retentionCutoff(NOW, OPERATIONAL_RECORD_RETENTION_MONTHS);
    expect(fn(prisma.auditEvent.deleteMany)).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
    expect(fn(prisma.aiResult.deleteMany)).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
  });

  it("deletes rate-limit buckets a minute after their window ended", async () => {
    await pruneRetainedRecords();
    expect(fn(prisma.rateLimitBucket.deleteMany)).toHaveBeenCalledWith({
      where: { windowEnd: { lt: new Date(NOW.getTime() - 60_000) } },
    });
  });

  it("reports what it deleted", async () => {
    await expect(pruneRetainedRecords()).resolves.toEqual({
      rateLimitBuckets: 3,
      auditEvents: 2,
      aiResults: 1,
    });
  });
});
