import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isCollaborator } from "@/lib/github/collaborators";

function globToRegex(pattern: string): RegExp {
  // Escape regex metachars, then translate `*` → `.*` and `?` → `.`.
  // Brackets and other characters are matched literally — GitHub bot
  // logins like `dependabot[bot]` should match `*[bot]` patterns.
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if (/[.+^${}()|\\\[\]/]/.test(ch)) out += "\\" + ch;
    else out += ch;
  }
  out += "$";
  return new RegExp(out, "i");
}

export type PrDecision =
  | { status: "APPROVED"; bypassReason?: "checker_disabled" }
  | { status: "BYPASSED"; reason: "bot" | "collaborator" }
  | { status: "PENDING" }
  | { status: "DENIED"; reason?: string | null; cooldownUntil?: Date | null }
  | { status: "IGNORED"; reason: string };

export function matchesAnyPattern(login: string, patterns: string[]): boolean {
  const target = login.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase().trim();
    if (!pat) return false;
    if (pat === target) return true;
    if (pat.includes("*") || pat.includes("?")) {
      return globToRegex(pat).test(target);
    }
    return false;
  });
}

function parseBypass(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string");
    return [];
  } catch {
    return [];
  }
}

export type RepoForDecision = Prisma.RepoGetPayload<{
  include: {
    project: {
      select: {
        id: true;
        cooldownDays: true;
        bypassHandles: true;
        bypassCollabs: true;
        checkerEnabled: true;
      };
    };
  };
}>;

export const decisionRepoInclude = {
  project: {
    select: {
      id: true,
      cooldownDays: true,
      bypassHandles: true,
      bypassCollabs: true,
      checkerEnabled: true,
    },
  },
} as const satisfies Prisma.RepoInclude;

/**
 * Pure-ish decision function operating on a loaded Repo row. Used directly
 * by the CI flow (where the repo has no GH App installation) and by the
 * `decideForPR` wrapper used by the App webhook.
 */
export async function decideForRepo(args: {
  repo: RepoForDecision;
  prAuthorGhLogin: string;
  prAuthorGhId: number;
  // CI workflows can compute their own collaborator check via GITHUB_TOKEN
  // and pass the result here, replacing the App-side Octokit call.
  isCollaboratorHint?: boolean;
}): Promise<PrDecision & { repoId?: string; projectId?: string }> {
  const { repo } = args;
  if (!repo.active) {
    return { status: "IGNORED", reason: "repo inactive (uninstalled)" };
  }

  // Disable switch: when off, every PR is treated as APPROVED. Caller decides
  // whether to still create PrCheck rows / run quality scoring (via the
  // project's trackWhenDisabled flag).
  if (repo.project.checkerEnabled === false) {
    return {
      status: "APPROVED",
      bypassReason: "checker_disabled",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  // 0) Admin-set manual decision wins over everything else
  const manual = await prisma.manualDecision.findUnique({
    where: {
      projectId_ghLogin: {
        projectId: repo.projectId,
        ghLogin: args.prAuthorGhLogin.toLowerCase(),
      },
    },
  });
  if (manual && manual.ghId === null) {
    await prisma.manualDecision
      .update({
        where: { id: manual.id },
        data: { ghId: args.prAuthorGhId },
      })
      .catch(() => undefined);
  }
  if (manual?.status === "APPROVED") {
    return {
      status: "APPROVED",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }
  if (manual?.status === "DENIED") {
    return {
      status: "DENIED",
      reason: manual.reason,
      cooldownUntil: null,
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  // 1) Bypass list
  const patterns = parseBypass(repo.project.bypassHandles);
  if (matchesAnyPattern(args.prAuthorGhLogin, patterns)) {
    return {
      status: "BYPASSED",
      reason: "bot",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  // 2) Collaborator auto-bypass
  if (repo.project.bypassCollabs && repo.installationId != null) {
    const [owner, name] = repo.fullName.split("/");
    try {
      if (
        owner &&
        name &&
        (await isCollaborator({
          installationId: repo.installationId,
          owner,
          repo: name,
          ghLogin: args.prAuthorGhLogin,
        }))
      ) {
        return {
          status: "BYPASSED",
          reason: "collaborator",
          repoId: repo.id,
          projectId: repo.projectId,
        };
      }
    } catch (e) {
      logger.warn(
        { err: e, repo: repo.fullName, ghLogin: args.prAuthorGhLogin },
        "collaborator check failed; falling through"
      );
    }
  } else if (repo.project.bypassCollabs && args.isCollaboratorHint) {
    return {
      status: "BYPASSED",
      reason: "collaborator",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  // 3) Look up applicant
  const user = await prisma.user.findUnique({
    where: { ghId: args.prAuthorGhId },
    select: { id: true },
  });

  if (!user) {
    return {
      status: "PENDING",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  const where = repo.requireOwnApproval
    ? {
        projectId: repo.projectId,
        userId: user.id,
        OR: [{ repoId: repo.id }, { repoId: null }],
      }
    : { projectId: repo.projectId, userId: user.id };

  const app = await prisma.application.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });

  if (!app) {
    return { status: "PENDING", repoId: repo.id, projectId: repo.projectId };
  }

  if (app.status === "APPROVED") {
    return { status: "APPROVED", repoId: repo.id, projectId: repo.projectId };
  }

  if (app.status === "DENIED") {
    const cooldownDays = repo.project.cooldownDays;
    const decidedAt = app.decidedAt ?? app.updatedAt;
    if (cooldownDays === null || cooldownDays === undefined) {
      return {
        status: "DENIED",
        reason: app.reason,
        cooldownUntil: null,
        repoId: repo.id,
        projectId: repo.projectId,
      };
    }
    const cooldownEnd = new Date(decidedAt.getTime() + cooldownDays * 86400000);
    if (cooldownEnd > new Date()) {
      return {
        status: "DENIED",
        reason: app.reason,
        cooldownUntil: cooldownEnd,
        repoId: repo.id,
        projectId: repo.projectId,
      };
    }
    return { status: "PENDING", repoId: repo.id, projectId: repo.projectId };
  }

  // SUBMITTED or REVOKED → pending.
  return { status: "PENDING", repoId: repo.id, projectId: repo.projectId };
}

/**
 * Webhook entry point: load the Repo by GitHub repo id, then delegate.
 */
export async function decideForPR(args: {
  ghRepoId: number;
  prAuthorGhLogin: string;
  prAuthorGhId: number;
}): Promise<PrDecision & { repoId?: string; projectId?: string }> {
  const repo = await prisma.repo.findUnique({
    where: { ghRepoId: args.ghRepoId },
    include: decisionRepoInclude,
  });
  if (!repo) {
    return { status: "IGNORED", reason: "repo not linked" };
  }
  return decideForRepo({
    repo,
    prAuthorGhLogin: args.prAuthorGhLogin,
    prAuthorGhId: args.prAuthorGhId,
  });
}
