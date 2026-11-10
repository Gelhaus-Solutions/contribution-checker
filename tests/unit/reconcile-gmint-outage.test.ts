import { beforeEach, describe, expect, it, vi } from "vitest";

const prCheckFindMany = vi.fn();
const prCheckUpdate = vi.fn();
const reopenPullRequest = vi.fn();
const decideForRepo = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    project: {
      findUnique: async () => ({
        labelsEnabled: false,
        labelPending: "contribution:pending",
        labelApproved: "contribution:approved",
        labelDenied: "contribution:denied",
      }),
    },
    repo: {
      findMany: async () => [
        { id: "r1", fullName: "acme/app", installationId: 99, projectId: "p1" },
        { id: "r2", fullName: "acme/docs", installationId: 99, projectId: "p1" },
      ],
    },
    prCheck: {
      findMany: (...a: unknown[]) => prCheckFindMany(...a),
      update: (...a: unknown[]) => prCheckUpdate(...a),
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: { githubAppConfigured: true, gmint: { appIds: [] } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/applications/decide-pr", () => ({
  decideForRepo: (...a: unknown[]) => decideForRepo(...a),
  decisionRepoInclude: {},
}));

vi.mock("@/lib/github/pr-actions", () => ({
  reopenPullRequest: (...a: unknown[]) => reopenPullRequest(...a),
  removeLabelIfPresent: vi.fn(),
  setLabels: vi.fn(),
  repoRef: (fullName: string, installationId: number) => ({
    fullName,
    installationId,
  }),
}));

import { reconcileProjectClosedPrs } from "@/lib/github/reconcile";
import { GmintRefusal } from "@/lib/github/gmint-tokens";

const closed = (n: number) => ({
  id: `c${n}`,
  prNumber: n,
  authorGhLogin: "octocat",
  authorGhId: 7,
});

beforeEach(() => {
  vi.clearAllMocks();
  prCheckFindMany.mockResolvedValue([closed(1), closed(2), closed(3)]);
  decideForRepo.mockResolvedValue({ status: "APPROVED" });
  reopenPullRequest.mockResolvedValue(undefined);
});

// Every remaining PR is refused the same way while GMint is down, and each
// refusal can take a transport timeout: a sweep that carried on hit its
// activity's start-to-close timeout on every interval of the 2026-11-09 outage.
describe("the reconcile sweep while GMint is not answering", () => {
  it("stops at the first outage, across repos, and ends normally", async () => {
    reopenPullRequest.mockRejectedValue(
      new GmintRefusal("transport", 503, true, "GMint is not answering"),
    );
    const res = await reconcileProjectClosedPrs("p1");
    expect(reopenPullRequest).toHaveBeenCalledTimes(1);
    expect(prCheckFindMany).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ reopened: 0, evaluated: 1 });
  });

  // A refusal for one PR says nothing about the next, so the sweep goes on.
  it("carries on past a refusal that is not an outage", async () => {
    reopenPullRequest.mockRejectedValueOnce(
      new GmintRefusal("denied", 403, false, "GMint does not allow this"),
    );
    const res = await reconcileProjectClosedPrs("p1");
    expect(reopenPullRequest).toHaveBeenCalledTimes(6);
    expect(res).toEqual({ reopened: 5, evaluated: 6 });
  });
});
