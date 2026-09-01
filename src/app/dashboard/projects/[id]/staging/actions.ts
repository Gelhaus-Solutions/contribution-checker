"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { reGateProjectPrs, signalStagingBatch } from "@/lib/temporal/start";
import {
  ALL_DIGEST_SECTION_IDS,
  serializeDigestSections,
  type DigestSectionId,
} from "@/lib/github/staging-digest";
import { parseStandingChecksInput } from "@/lib/qa/settings";

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

/** Section ids come from a checkbox group, so the browser sends only the
 * checked ones and an all-off form sends nothing at all. Unknown ids are
 * rejected rather than dropped: they can only come from a hand-edited form. */
const digestSection = z.enum(
  ALL_DIGEST_SECTION_IDS as [DigestSectionId, ...DigestSectionId[]],
);

const defaultsSchema = z.object({
  projectId: z.string().min(1),
  stagingRetargetEnabled: z.string().optional(),
  stagingBatchPrEnabled: z.string().optional(),
  stagingSyncEnabled: z.string().optional(),
  stagingDigestEnabled: z.string().optional(),
  stagingDigestSections: z.array(digestSection),
  stagingBranch: branchName,
  labelStagingBatch: stagingLabel,
  labelStagingIgnore: stagingLabel,
  labelStagingRepoint: stagingLabel,
});

export async function updateStagingDefaults(formData: FormData) {
  const parsed = defaultsSchema.parse({
    projectId: formData.get("projectId"),
    stagingRetargetEnabled:
      formData.get("stagingRetargetEnabled") ?? undefined,
    stagingBatchPrEnabled: formData.get("stagingBatchPrEnabled") ?? undefined,
    stagingSyncEnabled: formData.get("stagingSyncEnabled") ?? undefined,
    stagingDigestEnabled: formData.get("stagingDigestEnabled") ?? undefined,
    stagingDigestSections: formData.getAll("stagingDigestSections"),
    stagingBranch: formData.get("stagingBranch"),
    labelStagingBatch: formData.get("labelStagingBatch"),
    labelStagingIgnore: formData.get("labelStagingIgnore"),
    labelStagingRepoint: formData.get("labelStagingRepoint"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      stagingRetargetEnabled: true,
      stagingBatchPrEnabled: true,
      stagingSyncEnabled: true,
      stagingDigestEnabled: true,
      stagingDigestSections: true,
      stagingBranch: true,
      labelStagingBatch: true,
      labelStagingIgnore: true,
      labelStagingRepoint: true,
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
    parsed.labelStagingIgnore,
    parsed.labelStagingRepoint,
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
    stagingDigestEnabled: !!parsed.stagingDigestEnabled,
    // Normalized through the serializer so the stored order matches the
    // catalog and a no-op save cannot look like a change in the audit log.
    stagingDigestSections: serializeDigestSections(parsed.stagingDigestSections),
    stagingBranch: parsed.stagingBranch,
    labelStagingBatch: parsed.labelStagingBatch,
    labelStagingIgnore: parsed.labelStagingIgnore,
    labelStagingRepoint: parsed.labelStagingRepoint,
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
          stagingDigestEnabled: [
            before.stagingDigestEnabled,
            after.stagingDigestEnabled,
          ],
          stagingDigestSections: [
            before.stagingDigestSections,
            after.stagingDigestSections,
          ],
          stagingBranch: [before.stagingBranch, after.stagingBranch],
          labelStagingBatch: [
            before.labelStagingBatch,
            after.labelStagingBatch,
          ],
          labelStagingIgnore: [
            before.labelStagingIgnore,
            after.labelStagingIgnore,
          ],
          labelStagingRepoint: [
            before.labelStagingRepoint,
            after.labelStagingRepoint,
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
    // The digest lives in the aggregate PR body, so changing it has to trigger
    // a reconcile: otherwise the new section only appears whenever the next PR
    // happens to merge into staging.
    batchAffecting:
      before.stagingBatchPrEnabled !== after.stagingBatchPrEnabled ||
      before.stagingSyncEnabled !== after.stagingSyncEnabled ||
      before.stagingDigestEnabled !== after.stagingDigestEnabled ||
      before.stagingDigestSections !== after.stagingDigestSections ||
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
  stagingDigestEnabled: triState,
  stagingQaEnabled: triState,
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
    stagingDigestEnabled: formData.get("stagingDigestEnabled"),
    stagingQaEnabled: formData.get("stagingQaEnabled"),
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
      stagingDigestEnabled: true,
      stagingQaEnabled: true,
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
    stagingDigestEnabled: toOverride(parsed.stagingDigestEnabled),
    stagingQaEnabled: toOverride(parsed.stagingQaEnabled),
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
          stagingDigestEnabled: [
            before.stagingDigestEnabled,
            after.stagingDigestEnabled,
          ],
          stagingQaEnabled: [before.stagingQaEnabled, after.stagingQaEnabled],
          stagingBranch: [before.stagingBranch, after.stagingBranch],
        }).filter(([, [a, b]]) => a !== b),
      ),
    },
  });

  // Any of these can change what this repo does, and re-gating is
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

/**
 * QA settings. Its own action rather than more fields on
 * `updateStagingDefaults`, because it is its own card and its own decision: a
 * project can run a batch for a year before anyone wants to gate it.
 */
const qaSchema = z.object({
  projectId: z.string().min(1),
  stagingQaEnabled: z.string().optional(),
  qaCheckEnabled: z.string().optional(),
  qaFailedLabel: stagingLabel,
  qaStandingChecks: z.string().max(8000),
});

export async function updateQaSettings(formData: FormData) {
  const parsed = qaSchema.parse({
    projectId: formData.get("projectId"),
    stagingQaEnabled: formData.get("stagingQaEnabled") ?? undefined,
    qaCheckEnabled: formData.get("qaCheckEnabled") ?? undefined,
    qaFailedLabel: formData.get("qaFailedLabel"),
    qaStandingChecks: formData.get("qaStandingChecks") ?? "",
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      stagingQaEnabled: true,
      qaCheckEnabled: true,
      qaFailedLabel: true,
      qaStandingChecks: true,
      labelPending: true,
      labelApproved: true,
      labelDenied: true,
      labelEvaluate: true,
      labelStagingBatch: true,
      labelStagingIgnore: true,
      labelStagingRepoint: true,
    },
  });
  if (!before) throw new Error("Project not found");

  // Same collision check the staging labels get. Two labels with one name means
  // one of the two features silently stops being able to find its own PRs.
  const allLabels = [
    before.labelPending,
    before.labelApproved,
    before.labelDenied,
    before.labelEvaluate,
    before.labelStagingBatch,
    before.labelStagingIgnore,
    before.labelStagingRepoint,
    parsed.qaFailedLabel,
  ];
  if (new Set(allLabels).size !== allLabels.length) {
    throw new Error(
      "The QA label must differ from the staging and PR labels.",
    );
  }

  const after = {
    stagingQaEnabled: !!parsed.stagingQaEnabled,
    qaCheckEnabled: !!parsed.qaCheckEnabled,
    qaFailedLabel: parsed.qaFailedLabel,
    // Normalized through the parser so a no-op save cannot look like a change
    // in the audit log, and so blank lines never become empty checks.
    qaStandingChecks: JSON.stringify(
      parseStandingChecksInput(parsed.qaStandingChecks),
    ),
  };

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: after,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "qa.settings_changed",
    payload: {
      changed: Object.fromEntries(
        Object.entries({
          stagingQaEnabled: [before.stagingQaEnabled, after.stagingQaEnabled],
          qaCheckEnabled: [before.qaCheckEnabled, after.qaCheckEnabled],
          qaFailedLabel: [before.qaFailedLabel, after.qaFailedLabel],
          qaStandingChecks: [
            before.qaStandingChecks,
            after.qaStandingChecks,
          ],
        }).filter(([, [a, b]]) => a !== b),
      ),
    },
  });

  // Rebuild every batch so the change shows up without waiting for a push:
  // turning QA on with no reconcile leaves an empty board and looks broken.
  await propagateStagingChange({
    projectId: parsed.projectId,
    retargetAffecting: false,
    retargetNowOn: false,
    batchAffecting: true,
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/staging`);
  revalidatePath(`/dashboard/projects/${parsed.projectId}/qa`);
}
