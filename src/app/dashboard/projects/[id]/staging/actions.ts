"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { reGateProjectPrs, signalStagingBatch } from "@/lib/temporal/start";

/**
 * Git forbids whitespace, `~^:?*[`, backslash, `..`, a leading `-` or `/`, a
 * trailing `/`, and a `.lock` suffix in a ref name. Validated here because the
 * value is interpolated straight into `refs/heads/{branch}` and into the
 * `compare/{base}...{head}` path, so a bad name is a broken API call rather
 * than a cosmetic problem.
 */
const branchName = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) =>
      !/[\s~^:?*[\\]/.test(v) &&
      !v.includes("..") &&
      !v.startsWith("-") &&
      !v.startsWith("/") &&
      !v.endsWith("/") &&
      !v.endsWith(".lock"),
    "not a valid git branch name",
  );

/** The `contribution:` namespace belongs to the gate: setLabels strips every
 * label in it that the gate did not just set, so a staging label placed there
 * would survive exactly until the next converge. */
const stagingLabel = z
  .string()
  .min(1)
  .max(50)
  .refine(
    (v) => !v.startsWith("contribution:"),
    "staging labels cannot use the contribution: prefix, which the gate owns",
  );

const defaultsSchema = z.object({
  projectId: z.string().min(1),
  stagingRetargetEnabled: z.string().optional(),
  stagingBatchPrEnabled: z.string().optional(),
  stagingSyncEnabled: z.string().optional(),
  stagingBranch: branchName,
  labelStagingBatch: stagingLabel,
  labelStagingOptOut: stagingLabel,
});

export async function updateStagingDefaults(formData: FormData) {
  const parsed = defaultsSchema.parse({
    projectId: formData.get("projectId"),
    stagingRetargetEnabled:
      formData.get("stagingRetargetEnabled") ?? undefined,
    stagingBatchPrEnabled: formData.get("stagingBatchPrEnabled") ?? undefined,
    stagingSyncEnabled: formData.get("stagingSyncEnabled") ?? undefined,
    stagingBranch: formData.get("stagingBranch"),
    labelStagingBatch: formData.get("labelStagingBatch"),
    labelStagingOptOut: formData.get("labelStagingOptOut"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      stagingRetargetEnabled: true,
      stagingBatchPrEnabled: true,
      stagingSyncEnabled: true,
      stagingBranch: true,
      labelStagingBatch: true,
      labelStagingOptOut: true,
      labelPending: true,
      labelApproved: true,
      labelDenied: true,
      labelEvaluate: true,
    },
  });
  if (!before) throw new Error("Project not found");

  // The gate labels are edited on the settings page, so check the collision
  // here rather than leaving two forms able to converge on the same name.
  const allLabels = [
    before.labelPending,
    before.labelApproved,
    before.labelDenied,
    before.labelEvaluate,
    parsed.labelStagingBatch,
    parsed.labelStagingOptOut,
  ];
  if (new Set(allLabels).size !== allLabels.length) {
    throw new Error(
      "The staging labels must differ from each other and from the PR labels.",
    );
  }

  const after = {
    stagingRetargetEnabled: !!parsed.stagingRetargetEnabled,
    stagingBatchPrEnabled: !!parsed.stagingBatchPrEnabled,
    stagingSyncEnabled: !!parsed.stagingSyncEnabled,
    stagingBranch: parsed.stagingBranch,
    labelStagingBatch: parsed.labelStagingBatch,
    labelStagingOptOut: parsed.labelStagingOptOut,
  };

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: after,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.staging_changed",
    payload: {
      scope: "project",
      changed: Object.fromEntries(
        Object.entries({
          stagingRetargetEnabled: [
            before.stagingRetargetEnabled,
            after.stagingRetargetEnabled,
          ],
          stagingBatchPrEnabled: [
            before.stagingBatchPrEnabled,
            after.stagingBatchPrEnabled,
          ],
          stagingSyncEnabled: [
            before.stagingSyncEnabled,
            after.stagingSyncEnabled,
          ],
          stagingBranch: [before.stagingBranch, after.stagingBranch],
          labelStagingBatch: [
            before.labelStagingBatch,
            after.labelStagingBatch,
          ],
          labelStagingOptOut: [
            before.labelStagingOptOut,
            after.labelStagingOptOut,
          ],
        }).filter(([, [a, b]]) => a !== b),
      ),
    },
  });

  await propagateStagingChange({
    projectId: parsed.projectId,
    retargetAffecting:
      before.stagingRetargetEnabled !== after.stagingRetargetEnabled ||
      before.stagingBranch !== after.stagingBranch,
    retargetNowOn: after.stagingRetargetEnabled,
    batchAffecting:
      before.stagingBatchPrEnabled !== after.stagingBatchPrEnabled ||
      before.stagingSyncEnabled !== after.stagingSyncEnabled ||
      before.stagingBranch !== after.stagingBranch,
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/staging`);
}

/** "inherit" is a distinct third state from on/off, so the repo selects are
 * tri-state rather than checkboxes. Empty branch means inherit too. */
const triState = z.enum(["inherit", "on", "off"]);

const repoSchema = z.object({
  projectId: z.string().min(1),
  repoId: z.string().min(1),
  stagingRetargetEnabled: triState,
  stagingBatchPrEnabled: triState,
  stagingSyncEnabled: triState,
  stagingBranch: z.union([z.string().length(0), branchName]),
});

function toOverride(v: z.infer<typeof triState>): boolean | null {
  return v === "inherit" ? null : v === "on";
}

export async function updateRepoStagingSettings(formData: FormData) {
  const parsed = repoSchema.parse({
    projectId: formData.get("projectId"),
    repoId: formData.get("repoId"),
    stagingRetargetEnabled: formData.get("stagingRetargetEnabled"),
    stagingBatchPrEnabled: formData.get("stagingBatchPrEnabled"),
    stagingSyncEnabled: formData.get("stagingSyncEnabled"),
    stagingBranch: formData.get("stagingBranch") ?? "",
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.repo.findUnique({
    where: { id: parsed.repoId },
    select: {
      projectId: true,
      fullName: true,
      stagingRetargetEnabled: true,
      stagingBatchPrEnabled: true,
      stagingSyncEnabled: true,
      stagingBranch: true,
    },
  });
  // Bind the repo to the project the caller was authorized against, so a
  // forged repoId cannot reach another project's repo.
  if (!before || before.projectId !== parsed.projectId) {
    throw new Error("Repo not found");
  }

  const after = {
    stagingRetargetEnabled: toOverride(parsed.stagingRetargetEnabled),
    stagingBatchPrEnabled: toOverride(parsed.stagingBatchPrEnabled),
    stagingSyncEnabled: toOverride(parsed.stagingSyncEnabled),
    stagingBranch: parsed.stagingBranch || null,
  };

  await prisma.repo.update({ where: { id: parsed.repoId }, data: after });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "settings.staging_changed",
    payload: {
      scope: "repo",
      repo: before.fullName,
      changed: Object.fromEntries(
        Object.entries({
          stagingRetargetEnabled: [
            before.stagingRetargetEnabled,
            after.stagingRetargetEnabled,
          ],
          stagingBatchPrEnabled: [
            before.stagingBatchPrEnabled,
            after.stagingBatchPrEnabled,
          ],
          stagingSyncEnabled: [
            before.stagingSyncEnabled,
            after.stagingSyncEnabled,
          ],
          stagingBranch: [before.stagingBranch, after.stagingBranch],
        }).filter(([, [a, b]]) => a !== b),
      ),
    },
  });

  // Any of the three can change what this repo does, and re-gating is
  // project-wide anyway, so do not try to be clever about which changed.
  await propagateStagingChange({
    projectId: parsed.projectId,
    retargetAffecting: true,
    retargetNowOn: after.stagingRetargetEnabled !== false,
    batchAffecting: true,
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/staging`);
}

/** Manual "reconcile now": rebuild one repo's aggregate PR immediately rather
 * than waiting for the next PR or push to signal its entity. */
export async function reconcileRepoStagingBatch(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const repoId = String(formData.get("repoId") ?? "");
  if (!projectId || !repoId) throw new Error("Missing project or repo");
  await requireProjectRole(projectId, "ADMIN");

  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { projectId: true },
  });
  if (!repo || repo.projectId !== projectId) throw new Error("Repo not found");

  await signalStagingBatch({ repoId, reason: "manual_reconcile" });
  revalidatePath(`/dashboard/projects/${projectId}/staging`);
}

/**
 * Push a staging config change out to the things that cache or act on it:
 * re-gate so tracked open PRs pick up a new base, and nudge each App-mode
 * repo's batch entity so the aggregate PR is rebuilt without waiting for the
 * next webhook.
 */
async function propagateStagingChange(args: {
  projectId: string;
  retargetAffecting: boolean;
  retargetNowOn: boolean;
  batchAffecting: boolean;
}): Promise<void> {
  if (args.retargetAffecting && args.retargetNowOn) {
    await reGateProjectPrs({
      projectId: args.projectId,
      reason: "staging_settings_changed",
    });
  }
  if (!args.batchAffecting) return;
  const repos = await prisma.repo.findMany({
    where: {
      projectId: args.projectId,
      active: true,
      installationId: { not: null },
    },
    select: { id: true },
  });
  for (const repo of repos) {
    await signalStagingBatch({
      repoId: repo.id,
      reason: "staging_settings_changed",
    });
  }
}
