import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getInstallationOctokit } from "@/lib/github/app";
import { recordAudit } from "@/lib/audit";
import { notifyProjectReviewers } from "@/lib/notifications/inbox";
import { publishClaVersion } from "@/lib/cla/mutations";

/**
 * Fetch a single file's UTF-8 content (and blob sha) from a repo via the
 * installation Octokit. Returns null if the path is missing or not a file.
 */
async function fetchRepoFile(args: {
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

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Auto-track + auto-version: when a push lands on the branch that backs a
 * project's repo-file-sourced CLA and the configured file changed, fetch the
 * new text and publish a new version (if the content actually changed). The
 * re-sign behavior follows the project's `claAutoVersionRequiresResign` flag.
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
    select: {
      id: true,
      kind: true,
      sourceType: true,
      sourceRepoId: true,
      sourcePath: true,
      sourceRef: true,
      contentHash: true,
    },
  });

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

    const fetched = await fetchRepoFile({
      installationId: repo.installationId,
      fullName: repo.fullName,
      path: v.sourcePath,
      ref: v.sourceRef,
    });
    if (!fetched || !fetched.content.trim()) continue;

    // No-op when the content is unchanged (avoid version churn on unrelated
    // edits to the same file path that produce identical bytes).
    if (sha256Hex(fetched.content) === v.contentHash) continue;

    const kind = v.kind as "ICLA" | "CCLA";
    const requireResign = project.claAutoVersionRequiresResign;
    try {
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
      published.push({ kind, version: result.version });

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

      // Only the require-resign case is actionable for prior signers.
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
      }
    } catch (err) {
      logger.warn(
        { err, projectId: project.id, kind, repo: repo.fullName },
        "cla: auto-version publish failed"
      );
    }
  }

  return { published };
}
