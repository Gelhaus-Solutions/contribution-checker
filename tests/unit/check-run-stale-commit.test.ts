import { beforeEach, describe, expect, it, vi } from "vitest";

const octokitRequest = vi.fn();

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: async () => ({
    request: (...a: unknown[]) => octokitRequest(...a),
  }),
}));

import { upsertCheckRun, type RepoRef } from "@/lib/github/pr-actions";

const ref: RepoRef = {
  owner: "acme",
  repo: "app",
  installationId: 99,
  tenant: "project:proj1",
};

const input = {
  headSha: "head",
  name: "contribution-checker / decision",
  status: "completed" as const,
  conclusion: "success" as const,
  title: "Approved",
  summary: "The author is approved.",
};

const routes = () => octokitRequest.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
});

// A run belongs to the commit it was created on and an update cannot move it.
// A PrCheck row from before the head SHA was recorded took the next head as its
// own and kept the id of a run on an older commit: every publish updated that
// run, GitHub answered 200, and the head never got its check.
describe("a stored check run that sits on another commit", () => {
  it("is updated in place while it is on the head", async () => {
    octokitRequest.mockResolvedValueOnce({ data: { id: 7, head_sha: "head" } });
    expect(await upsertCheckRun(ref, input, "7")).toBe("7");
    expect(routes()).toEqual([
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    ]);
  });

  it("is left behind for a new run on the head", async () => {
    octokitRequest
      .mockResolvedValueOnce({ data: { id: 7, head_sha: "older" } })
      .mockResolvedValueOnce({ data: { id: 8, head_sha: "head" } });
    expect(await upsertCheckRun(ref, input, "7")).toBe("8");
    expect(routes()).toEqual([
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      "POST /repos/{owner}/{repo}/check-runs",
    ]);
    expect(octokitRequest.mock.calls[1][1]).toMatchObject({
      head_sha: "head",
      name: "contribution-checker / decision",
      conclusion: "success",
    });
  });

  // An answer that names no commit says nothing against the stored id.
  it("is trusted when GitHub does not say which commit it is on", async () => {
    octokitRequest.mockResolvedValueOnce({ data: { id: 7 } });
    expect(await upsertCheckRun(ref, input, "7")).toBe("7");
    expect(octokitRequest).toHaveBeenCalledTimes(1);
  });

  // The create that follows is a create: a 404 from it must not be taken for
  // the stale-id update and send a second one.
  it("does not create twice when the new run is refused", async () => {
    octokitRequest
      .mockResolvedValueOnce({ data: { id: 7, head_sha: "older" } })
      .mockRejectedValueOnce(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );
    expect(await upsertCheckRun(ref, input, "7")).toBeNull();
    expect(octokitRequest).toHaveBeenCalledTimes(2);
  });
});
