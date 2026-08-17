import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isCollaborator } from "@/lib/github/collaborators";
import { getClaStatus } from "@/lib/cla/status";

function globToRegex(pattern: string): RegExp {
  // Escape regex metachars, then translate `*` → `.*` and `?` → `.`.
  // Brackets and other characters are matched literally; GitHub bot
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

export type PendingReason =
  | "no-application"
  | "submitted"
  | "cooldown-elapsed";

// Non-closing gate reasons. `decideForRepo` only ever emits "cla_required" |
// "cla_stale"; "dco_missing" is produced in the webhook/CI side-effect layer
// (it needs the PR's commits, which the decision path doesn't load).
export type CheckRequiredReason = "cla_required" | "cla_stale" | "dco_missing";

export type PrDecision =
  // `staging_batch` is never produced by `decideForRepo`: it is synthesized by
  // the webhook layer for the bot's own aggregate staging PR, which skips the
  // gate but must still publish a green check.
  | { status: "APPROVED"; bypassReason?: "checker_disabled" | "staging_batch" }
  | { status: "BYPASSED"; reason: "bot" | "collaborator" }
  | { status: "PENDING"; reason: PendingReason }
  | { status: "CHECK_REQUIRED"; reason: CheckRequiredReason }
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
        bypassHandles: true;
        bypassCollabs: true;
        checkerEnabled: true;
        applicationRequired: true;
        claEnabled: true;
        claRequired: true;
      };
    };
  };
}>;

export const decisionRepoInclude = {
  project: {
    select: {
      id: true,
      bypassHandles: true,
      bypassCollabs: true,
      checkerEnabled: true,
      applicationRequired: true,
      claEnabled: true,
      claRequired: true,
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

  // The "allowing" base decision (APPROVED or BYPASSED{collaborator}) is
  // computed but NOT returned immediately, so the CLA gate below can be layered
  // on top of it. Outcomes that are not allowing (manual/app DENIED, the
  // application PENDING states) short-circuit with an immediate return. Denied
  // users are never invited to sign and bots (returned above) are exempt.
  let base:
    | (PrDecision & { repoId: string; projectId: string })
    | null = null;

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
  // Manual DENIED short-circuits before any CLA layering: a denied user is
  // never asked to sign.
  if (manual?.status === "DENIED") {
    return {
      status: "DENIED",
      reason: manual.reason,
      cooldownUntil: null,
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  // 1) Bypass list: bots are EXEMPT from CLA/DCO; return immediately so the
  //    coverage check below is never queried for them.
  const patterns = parseBypass(repo.project.bypassHandles);
  if (matchesAnyPattern(args.prAuthorGhLogin, patterns)) {
    return {
      status: "BYPASSED",
      reason: "bot",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  if (manual?.status === "APPROVED") {
    base = {
      status: "APPROVED",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  // 2) Collaborator auto-bypass
  if (!base && repo.project.bypassCollabs && repo.installationId != null) {
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
        base = {
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
  } else if (
    !base &&
    repo.project.bypassCollabs &&
    args.isCollaboratorHint
  ) {
    base = {
      status: "BYPASSED",
      reason: "collaborator",
      repoId: repo.id,
      projectId: repo.projectId,
    };
  }

  // 3) Application lookup. When `applicationRequired` is off (feature 2), a
  //    missing/SUBMITTED application no longer blocks; only an existing DENIAL
  //    still does. When it is on, behavior is unchanged.
  if (!base) {
    const appRequired = repo.project.applicationRequired !== false;

    // 3) Look up applicant
    const user = await prisma.user.findUnique({
      where: { ghId: args.prAuthorGhId },
      select: { id: true },
    });

    if (!user) {
      if (appRequired) {
        return {
          status: "PENDING",
          reason: "no-application",
          repoId: repo.id,
          projectId: repo.projectId,
        };
      }
      // applicationRequired:false means no account/application is fine.
      base = { status: "APPROVED", repoId: repo.id, projectId: repo.projectId };
    } else {
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
        if (appRequired) {
          return {
            status: "PENDING",
            reason: "no-application",
            repoId: repo.id,
            projectId: repo.projectId,
          };
        }
        base = {
          status: "APPROVED",
          repoId: repo.id,
          projectId: repo.projectId,
        };
      } else if (app.status === "APPROVED") {
        base = {
          status: "APPROVED",
          repoId: repo.id,
          projectId: repo.projectId,
        };
      } else if (app.status === "DENIED") {
        // Existing denials STILL block, regardless of applicationRequired.
        if (!app.allowResubmit) {
          return {
            status: "DENIED",
            reason: app.reason,
            cooldownUntil: null,
            repoId: repo.id,
            projectId: repo.projectId,
          };
        }
        if (app.cooldownUntil && app.cooldownUntil > new Date()) {
          return {
            status: "DENIED",
            reason: app.reason,
            cooldownUntil: app.cooldownUntil,
            repoId: repo.id,
            projectId: repo.projectId,
          };
        }
        return {
          status: "PENDING",
          reason: "cooldown-elapsed",
          repoId: repo.id,
          projectId: repo.projectId,
        };
      } else {
        // SUBMITTED → awaiting reviewer action.
        if (appRequired) {
          return {
            status: "PENDING",
            reason: "submitted",
            repoId: repo.id,
            projectId: repo.projectId,
          };
        }
        base = {
          status: "APPROVED",
          repoId: repo.id,
          projectId: repo.projectId,
        };
      }
    }
  }

  // CLA gate: layered only on an allowing base (APPROVED or
  // BYPASSED{collaborator}). Bots already returned above and are exempt. Runs
  // the coverage lookup at most once. DCO is evaluated in the side-effect layer
  // (it needs the PR's commits), so it is not handled here.
  if (
    base &&
    (base.status === "APPROVED" || base.status === "BYPASSED") &&
    repo.project.claEnabled &&
    repo.project.claRequired
  ) {
    const status = await getClaStatus({
      projectId: repo.projectId,
      ghId: args.prAuthorGhId,
      ghLogin: args.prAuthorGhLogin,
    });
    if (!status.satisfied) {
      return {
        status: "CHECK_REQUIRED",
        reason: status.needsResign ? "cla_stale" : "cla_required",
        repoId: repo.id,
        projectId: repo.projectId,
      };
    }
  }

  // Every reachable path above either sets `base` or returns directly; the
  // fallback keeps the function total for the type-checker.
  return (
    base ?? {
      status: "APPROVED",
      repoId: repo.id,
      projectId: repo.projectId,
    }
  );
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
