import { describe, expect, it, vi, beforeEach } from "vitest";

// An applicant signed in without a linked GitHub account (an email or Google
// sign-up) could apply, and so skip the CLA the project requires: the CLA is
// signed as the GitHub account, and the requirement was only checked when
// there was one. Their applications showed "(no login)". Applying now needs
// the account linked, and a row with the id but not the login gets the login.

const session = vi.fn();
const projectFindUnique = vi.fn();
const fillGithubLogin = vi.fn();
const submitApplication = vi.fn();

vi.mock("@/auth", () => ({ auth: () => session() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
  },
}));
vi.mock("@/lib/authz", () => ({ termsRefuseWrite: () => false }));
vi.mock("@/lib/auth/sync-user", () => ({
  fillGithubLogin: (...a: unknown[]) => fillGithubLogin(...a),
}));
vi.mock("@/lib/applications/lifecycle", () => ({
  submitApplication: (...a: unknown[]) => submitApplication(...a),
  submitAppeal: vi.fn(),
}));
vi.mock("@/lib/applications/decide", () => ({
  notifyAdminsOfNewApplication: vi.fn(),
  notifyAdminsOfAppeal: vi.fn(),
}));
vi.mock("@/lib/cla/status", () => ({
  getClaStatus: vi.fn(),
  invalidateClaCache: vi.fn(),
}));
vi.mock("@/lib/cla/mutations", () => ({ recordIclaSignature: vi.fn() }));
vi.mock("@/lib/cla/post-sign", () => ({ onClaCoverageChanged: vi.fn() }));
vi.mock("@/lib/cla/store", () => ({ claStore: vi.fn() }));
vi.mock("@/lib/cla/notify", () => ({ notifyApplicantClaRequired: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { applyAction } from "@/app/p/[slug]/actions";
import { safeNextPath, welcomeFor } from "@/lib/auth/next-path";

const project = {
  id: "p1",
  slug: "postiz",
  formSchema: "[]",
  claEnabled: true,
  claRequired: true,
  claPlacementEmbed: true,
  claIclaRequireSignature: false,
  claIclaCustomFields: null,
  currentIclaVersionId: "v1",
};

function form(): FormData {
  const data = new FormData();
  data.set("projectId", "p1");
  return data;
}

beforeEach(() => {
  session.mockReset();
  projectFindUnique.mockReset().mockResolvedValue(project);
  fillGithubLogin.mockReset();
  submitApplication.mockReset();
});

describe("applying", () => {
  it("is refused without a linked GitHub account, and nothing is written", async () => {
    session.mockResolvedValue({
      user: { id: "u1", ghId: null, ghLogin: null, email: "a@b.example" },
    });
    const answer = await applyAction({ status: "idle" } as never, form());
    expect(answer).toMatchObject({ status: "error" });
    expect((answer as { reason: string }).reason).toMatch(
      /Link your GitHub account first/u,
    );
    expect(submitApplication).not.toHaveBeenCalled();
    expect(fillGithubLogin).not.toHaveBeenCalled();
  });

  it("asks GitHub for a missing login, and refuses while the CLA cannot be signed without it", async () => {
    session.mockResolvedValue({
      user: { id: "u1", ghId: 42, ghLogin: null, email: "a@b.example" },
    });
    fillGithubLogin.mockResolvedValue(null);
    const answer = await applyAction({ status: "idle" } as never, form());
    expect(fillGithubLogin).toHaveBeenCalledWith("u1", 42);
    expect((answer as { reason: string }).reason).toMatch(
      /GitHub did not tell us your login/u,
    );
    expect(submitApplication).not.toHaveBeenCalled();
  });
});

describe("safeNextPath", () => {
  it("keeps a path on this site", () => {
    expect(safeNextPath("/p/postiz")).toBe("/p/postiz");
    expect(safeNextPath(" /p/postiz/cla ")).toBe("/p/postiz/cla");
    expect(welcomeFor("/p/postiz")).toBe("/welcome?next=%2Fp%2Fpostiz");
  });

  it("refuses anything that leaves it", () => {
    for (const raw of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "evil",
      "",
      null,
      7,
      `/${"a".repeat(400)}`,
    ]) {
      expect(safeNextPath(raw)).toBeNull();
    }
  });
});
