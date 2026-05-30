import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getInstallationOctokit } from "@/lib/github/app";
import { recordAudit } from "@/lib/audit";
import { notifyProjectReviewers } from "@/lib/notifications/inbox";
import { publishClaVersion } from "@/lib/cla/mutations";
import { onClaCoverageRevoked } from "@/lib/cla/post-sign";

/**
 * Fetch a single file's UTF-8 content (and blob sha) from a repo via the
 * installation Octokit. Returns null if the path is missing or not a file.
 *
 * Exported so the publish/preview/sync server actions share one fetch path.
 */
export async function fetchRepoFile(args: {
  installationId: number;
  fullName: string;
  path: string;
  ref?: string | null;
}): Promise<{ content: string; sha: string | null } | null> {
  const [owner, repo] = args.fullName.split("/");
  if (!owner || !repo) return null;
  try {
    const octokit = await getInstallationOctokit(args.installationId);
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner,
        repo,
        path: args.path,
        ...(args.ref ? { ref: args.ref } : {}),
      }
    );
    const data = res.data as {
      type?: string;
      content?: string;
      encoding?: string;
      sha?: string;
    };
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      return null;
    }
    const content = Buffer.from(
      data.content,
      (data.encoding as BufferEncoding) ?? "base64"
    ).toString("utf8");
    return { content, sha: data.sha ?? null };
  } catch (err) {
    logger.warn(
      { err, repo: args.fullName, path: args.path },
      "cla: repo-file fetch failed"
    );
    return null;
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Live repo-file source view for a kind's current version (drift indicator). */
export type RepoSourceView =
  | { sourced: false }
  | {
      sourced: true;
      available: false;
      fullName: string;
      sourcePath: string;
      sourceRef: string | null;
      storedCommitSha: string | null;
    }
  | {
      sourced: true;
      available: true;
      fullName: string;
      sourcePath: string;
      sourceRef: string | null;
      storedCommitSha: string | null;
      content: string;
      liveSha: string | null;
      storedHash: string;
      liveHash: string;
      matchesStored: boolean;
    };

/** Per-kind outcome of a sync (push or manual) over a repo-file CLA source. */
export type SyncOutcome =
  | { kind: "ICLA" | "CCLA"; status: "unchanged" }
  | { kind: "ICLA" | "CCLA"; status: "published"; version: number }
  | { kind: "ICLA" | "CCLA"; status: "pending"; pendingChangeId: string }
  | { kind: "ICLA" | "CCLA"; status: "error"; message: string };

type RepoRef = { id: string; fullName: string; installationId: number };
type ProjectFlags = {
  id: string;
  claAutoVersionRequiresResign: boolean;
  claRepoFileReviewMode: boolean;
};
type SourceVersion = {
  id: string;
  kind: string;
  sourceType: string;
  sourceRepoId: string | null;
  sourcePath: string | null;
  sourceRef: string | null;
  contentHash: string;
};

/**
 * Detect drift on one repo-file-backed current version and apply the project's
 * policy. The single code path shared by the push webhook and the manual Sync
 * action so the two never diverge:
 *  - unchanged content (or empty/whitespace fetch failure) -> no-op, and any
 *    stale PENDING change for the same (project, kind, path) is superseded;
 *  - review mode -> upsert ONE pending change (dedup by project+kind+path);
 *  - auto mode -> publish a new version (requireResign from the project flag)
 *    and re-gate signers whose coverage was revoked.
 *
 * Never throws: returns an `error` outcome instead, so the best-effort push
 * caller and the admin-facing manual caller can each decide what to surface.
 */
async function detectAndApply(args: {
  repo: RepoRef;
  project: ProjectFlags;
  version: SourceVersion;
}): Promise<SyncOutcome | null> {
  const { repo, project, version: v } = args;
  const kind = v.kind as "ICLA" | "CCLA";
  if (!v.sourcePath) return null;

  const fetched = await fetchRepoFile({
    installationId: repo.installationId,
    fullName: repo.fullName,
    path: v.sourcePath,
    ref: v.sourceRef,
  });
  if (!fetched || !fetched.content.trim()) {
    return { kind, status: "error", message: "Could not read the file from the repo." };
  }

  // No-op when the content is unchanged. Also supersede any open pending change
  // (e.g. the file was edited then reverted to the published content).
  if (sha256Hex(fetched.content) === v.contentHash) {
    await supersedePendingChanges(project.id, kind, v.sourcePath);
    return { kind, status: "unchanged" };
  }

  if (project.claRepoFileReviewMode) {
    const pending = await upsertPendingChange({
      projectId: project.id,
      kind,
      sourceRepoId: repo.id,
      sourcePath: v.sourcePath,
      sourceRef: v.sourceRef,
      detectedCommitSha: fetched.sha,
      detectedContent: fetched.content,
      contentHash: sha256Hex(fetched.content),
    });
    await recordAudit({
      projectId: project.id,
      actorId: null,
      kind: "cla.pending_change_detected",
      payload: {
        kind,
        repo: repo.fullName,
        path: v.sourcePath,
        pendingChangeId: pending.id,
      },
    }).catch(() => undefined);
    await notifyProjectReviewers({
      projectId: project.id,
      kind: "cla.pending_change",
      payload: { kind, repo: repo.fullName, path: v.sourcePath },
    }).catch(() => undefined);
    return { kind, status: "pending", pendingChangeId: pending.id };
  }

  // Auto mode: publish a new version.
  const requireResign = project.claAutoVersionRequiresResign;
  const result = await publishClaVersion({
    projectId: project.id,
    kind,
    bodyMarkdown: fetched.content,
    sourceType: "repo_file",
    sourceRepoId: repo.id,
    sourcePath: v.sourcePath,
    sourceRef: v.sourceRef,
    sourceCommitSha: fetched.sha,
    requireResign,
    actorUserId: null,
  });

  await recordAudit({
    projectId: project.id,
    actorId: null,
    kind: "cla.version_published",
    payload: {
      kind,
      version: result.version,
      contentHash: result.contentHash,
      source: "repo_file_auto",
      repo: repo.fullName,
      path: v.sourcePath,
      requireResign,
    },
  }).catch(() => undefined);

  if (requireResign) {
    await notifyProjectReviewers({
      projectId: project.id,
      kind: "cla.resign_required",
      payload: {
        kind,
        version: result.version,
        reason: "auto-published from repo file; re-sign required",
      },
    }).catch(() => undefined);
    // Re-gate contributors whose coverage was revoked by the forced re-sign.
    if (result.affectedGhIds.length > 0) {
      await onClaCoverageRevoked({
        projectId: project.id,
        ghIds: result.affectedGhIds,
      }).catch(() => undefined);
    }
  }

  return { kind, status: "published", version: result.version };
}

/**
 * Upsert the single PENDING change for (projectId, kind, sourcePath): refresh
 * the existing row in place across repeated pushes, else create one. Prisma has
 * no portable partial-unique on status=PENDING, so we find-then-write.
 */
async function upsertPendingChange(a: {
  projectId: string;
  kind: "ICLA" | "CCLA";
  sourceRepoId: string;
  sourcePath: string;
  sourceRef: string | null;
  detectedCommitSha: string | null;
  detectedContent: string;
  contentHash: string;
}): Promise<{ id: string }> {
  const existing = await prisma.claPendingChange.findFirst({
    where: {
      projectId: a.projectId,
      kind: a.kind,
      sourcePath: a.sourcePath,
      status: "PENDING",
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.claPendingChange.update({
      where: { id: existing.id },
      data: {
        sourceRepoId: a.sourceRepoId,
        sourceRef: a.sourceRef,
        detectedCommitSha: a.detectedCommitSha,
        detectedContent: a.detectedContent,
        contentHash: a.contentHash,
      },
    });
    return existing;
  }
  return prisma.claPendingChange.create({
    data: {
      projectId: a.projectId,
      kind: a.kind,
      sourceRepoId: a.sourceRepoId,
      sourcePath: a.sourcePath,
      sourceRef: a.sourceRef,
      detectedCommitSha: a.detectedCommitSha,
      detectedContent: a.detectedContent,
      contentHash: a.contentHash,
    },
    select: { id: true },
  });
}

/** Mark any open PENDING change for (project, kind, path) as SUPERSEDED. */
async function supersedePendingChanges(
  projectId: string,
  kind: "ICLA" | "CCLA",
  sourcePath: string
): Promise<void> {
  await prisma.claPendingChange
    .updateMany({
      where: { projectId, kind, sourcePath, status: "PENDING" },
      data: { status: "SUPERSEDED", reviewedAt: new Date() },
    })
    .catch(() => undefined);
}

const SOURCE_VERSION_SELECT = {
  id: true,
  kind: true,
  sourceType: true,
  sourceRepoId: true,
  sourcePath: true,
  sourceRef: true,
  contentHash: true,
} as const;

/**
 * Auto-track + auto-version: when a push lands on the branch that backs a
 * project's repo-file-sourced CLA and the configured file changed, fetch the
 * new text and apply the project's policy (auto-publish, or queue a pending
 * change in review mode).
 *
 * Best-effort and defensive: any failure is logged, never thrown. This runs
 * inside the GitHub `push` webhook handler.
 */
export async function syncRepoFileClaForPush(args: {
  ghRepoId: number;
  branch: string;
  defaultBranch: string;
  // Set of file paths touched by the push, or null when it can't be determined
  // (e.g. a truncated commit list); null forces a re-fetch to be safe.
  changedPaths: Set<string> | null;
}): Promise<{ published: { kind: "ICLA" | "CCLA"; version: number }[] }> {
  const published: { kind: "ICLA" | "CCLA"; version: number }[] = [];

  const repo = await prisma.repo.findUnique({
    where: { ghRepoId: args.ghRepoId },
    select: {
      id: true,
      fullName: true,
      installationId: true,
      project: {
        select: {
          id: true,
          claEnabled: true,
          claAutoVersionRequiresResign: true,
          claRepoFileReviewMode: true,
          currentIclaVersionId: true,
          currentCclaVersionId: true,
        },
      },
    },
  });
  if (!repo || repo.installationId == null) return { published };
  const project = repo.project;
  if (!project.claEnabled) return { published };

  const versionIds = [
    project.currentIclaVersionId,
    project.currentCclaVersionId,
  ].filter((v): v is string => !!v);
  if (versionIds.length === 0) return { published };

  const versions = await prisma.claDocumentVersion.findMany({
    where: { id: { in: versionIds } },
    select: SOURCE_VERSION_SELECT,
  });

  const repoRef: RepoRef = {
    id: repo.id,
    fullName: repo.fullName,
    installationId: repo.installationId,
  };
  const projectFlags: ProjectFlags = {
    id: project.id,
    claAutoVersionRequiresResign: project.claAutoVersionRequiresResign,
    claRepoFileReviewMode: project.claRepoFileReviewMode,
  };

  for (const v of versions) {
    if (v.sourceType !== "repo_file") continue;
    if (v.sourceRepoId !== repo.id) continue;
    if (!v.sourcePath) continue;

    // The branch this CLA tracks: an explicit sourceRef, else the default branch
    // (which is what a null-ref fetch resolved to at publish time).
    const effectiveRef = v.sourceRef ?? args.defaultBranch;
    if (args.branch !== effectiveRef) continue;

    // Skip when we know the push didn't touch the file.
    if (args.changedPaths && !args.changedPaths.has(v.sourcePath)) continue;

    try {
      const outcome = await detectAndApply({
        repo: repoRef,
        project: projectFlags,
        version: v,
      });
      if (outcome?.status === "published") {
        published.push({ kind: outcome.kind, version: outcome.version });
      }
    } catch (err) {
      logger.warn(
        { err, projectId: project.id, kind: v.kind, repo: repo.fullName },
        "cla: auto-version publish failed"
      );
    }
  }

  return { published };
}

/**
 * Manual "Sync now": re-fetch the live repo file for each repo-file-sourced
 * current version of a project (optionally one kind) and apply the project's
 * policy. Unlike the push path this is admin-initiated, so errors are surfaced
 * in the returned structured result rather than swallowed. Runs the SAME
 * detect/apply core as the push sync.
 */
export async function syncClaRepoSourceNow(args: {
  projectId: string;
  kind?: "ICLA" | "CCLA";
}): Promise<{ results: SyncOutcome[] }> {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: {
      id: true,
      claAutoVersionRequiresResign: true,
      claRepoFileReviewMode: true,
      currentIclaVersionId: true,
      currentCclaVersionId: true,
    },
  });
  if (!project) return { results: [] };

  const versionIds = [
    project.currentIclaVersionId,
    project.currentCclaVersionId,
  ].filter((v): v is string => !!v);
  if (versionIds.length === 0) return { results: [] };

  const versions = await prisma.claDocumentVersion.findMany({
    where: { id: { in: versionIds } },
    select: SOURCE_VERSION_SELECT,
  });

  // ClaDocumentVersion.sourceRepoId is a plain scalar (no relation), so resolve
  // the source repos in one query and index them by id.
  const repoIds = Array.from(
    new Set(versions.map((v) => v.sourceRepoId).filter((id): id is string => !!id))
  );
  const repos = repoIds.length
    ? await prisma.repo.findMany({
        where: { id: { in: repoIds } },
        select: { id: true, fullName: true, installationId: true },
      })
    : [];
  const repoById = new Map(repos.map((r) => [r.id, r]));

  const projectFlags: ProjectFlags = {
    id: project.id,
    claAutoVersionRequiresResign: project.claAutoVersionRequiresResign,
    claRepoFileReviewMode: project.claRepoFileReviewMode,
  };

  const results: SyncOutcome[] = [];
  for (const v of versions) {
    const kind = v.kind as "ICLA" | "CCLA";
    if (args.kind && kind !== args.kind) continue;
    if (v.sourceType !== "repo_file") continue;
    if (!v.sourcePath || !v.sourceRepoId) continue;
    const sourceRepo = repoById.get(v.sourceRepoId);
    if (!sourceRepo || sourceRepo.installationId == null) {
      results.push({
        kind,
        status: "error",
        message: "The source repo has no GitHub App installation.",
      });
      continue;
    }
    try {
      const outcome = await detectAndApply({
        repo: {
          id: sourceRepo.id,
          fullName: sourceRepo.fullName,
          installationId: sourceRepo.installationId,
        },
        project: projectFlags,
        version: v,
      });
      if (outcome) results.push(outcome);
    } catch (err) {
      logger.warn(
        { err, projectId: project.id, kind, repo: sourceRepo.fullName },
        "cla: manual sync failed"
      );
      results.push({
        kind,
        status: "error",
        message: "Sync failed; see server logs.",
      });
    }
  }

  await recordAudit({
    projectId: project.id,
    actorId: null,
    kind: "cla.repo_sync_run",
    payload: { results },
  }).catch(() => undefined);

  return { results };
}
