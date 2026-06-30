import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  decideForRepo,
  decisionRepoInclude,
  type RepoForDecision,
} from "@/lib/applications/decide-pr";
import type { GhActionsClaims, CoreResult } from "./check-pr-core";

export const ciReconcileBodySchema = z.object({
  projectSlug: z.string().min(1).max(140),
});

export type CiReconcileBody = z.infer<typeof ciReconcileBodySchema>;

/**
 * CI reconcile business logic, extracted from the old route to run inside the
 * `ciReconcile` Temporal activity. Returns the list of PRs that now pass and
 * should be reopened; the Action performs the reopen with its own token.
 */
export async function computeCiReconcile(input: {
  body: CiReconcileBody;
  claims: GhActionsClaims;
}): Promise<CoreResult> {
  const { body, claims } = input;

  const project = await prisma.project.findUnique({
    where: { slug: body.projectSlug },
    select: {
      id: true,
      name: true,
      labelsEnabled: true,
      labelPending: true,
      labelApproved: true,
      labelDenied: true,
    },
  });
  if (!project) return { status: 404, json: { error: "project not found" } };

  const repo = await prisma.repo.findUnique({
    where: {
      projectId_fullName: { projectId: project.id, fullName: claims.repository },
    },
    include: decisionRepoInclude,
  });
  if (!repo || !repo.active) {
    return { status: 404, json: { error: "repo not registered" } };
  }
  if (repo.installationId != null) {
    return { status: 409, json: { error: "repo is App-installed; CI mode disabled" } };
  }

  const closed = await prisma.prCheck.findMany({
    where: { repoId: repo.id, closedByApp: true },
  });

  const reopens: Array<{
    prCheckId: string;
    prNumber: number;
    body: string;
    labels: { add: string[]; remove: string[] } | null;
  }> = [];
  for (const check of closed) {
    const decision = await decideForRepo({
      repo: repo as RepoForDecision,
      prAuthorGhLogin: check.authorGhLogin,
      prAuthorGhId: check.authorGhId,
    });
    if (decision.status !== "APPROVED" && decision.status !== "BYPASSED") continue;
    const labels = project.labelsEnabled
      ? {
          add: [project.labelApproved],
          remove: [project.labelPending, project.labelDenied],
        }
      : null;
    reopens.push({
      prCheckId: check.id,
      prNumber: check.prNumber,
      body: `@${check.authorGhLogin}'s application for **${project.name}** was approved. Reopening this PR.`,
      labels,
    });
  }

  return { status: 200, json: { reopens } };
}
