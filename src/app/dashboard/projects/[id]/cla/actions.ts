"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import {
  claSettingsSchema,
  publishVersionSchema,
  setVersionResignSchema,
  approvePendingChangeSchema,
  rejectPendingChangeSchema,
  waiverSchema,
  saveCustomFieldsSchema,
} from "@/lib/cla/schema";
import { formSchema as formSchemaValidator } from "@/lib/applications/schema";
import * as claMutations from "@/lib/cla/mutations";
import {
  fetchRepoFile,
  sha256Hex,
  syncClaRepoSourceNow as syncClaRepoSourceNowCore,
  type SyncOutcome,
  type RepoSourceView,
} from "@/lib/cla/repo-source";
import {
  onClaCoverageChanged,
  onClaCoverageRevoked,
} from "@/lib/cla/post-sign";
import { sweepUnsignedApplicants } from "@/lib/cla/notify";

function revalidateCla(projectId: string) {
  revalidatePath(`/dashboard/projects/${projectId}/cla`);
}

/**
 * Drive both coverage directions for a set of affected contributors after a
 * re-sign change: re-gate any whose now-stale signature was holding a passing
 * PR (loss), and re-check any whose signature is now valid again (gain). Both
 * are idempotent and act on disjoint PrCheck states, so calling both is safe.
 */
async function driveCoverage(projectId: string, ghIds: number[]) {
  if (ghIds.length === 0) return;
  await onClaCoverageRevoked({ projectId, ghIds }).catch(() => undefined);
  for (const ghId of ghIds) {
    await onClaCoverageChanged({ projectId, ghId }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Save CLA custom fields (per kind). Validates the posted JSON as a Field[]
// using the shared application form-schema validator, then persists to the
// matching Project column. Mirrors the FormBuilder save contract (FormData with
// `schema` = JSON Field[]).
// ---------------------------------------------------------------------------
export async function saveClaCustomFields(formData: FormData) {
  const parsed = saveCustomFieldsSchema.parse({
    projectId: formData.get("projectId"),
    kind: formData.get("kind"),
    schema: formData.get("schema"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  let fields: unknown;
  try {
    fields = JSON.parse(parsed.schema);
  } catch {
    throw new Error("Custom fields must be valid JSON.");
  }
  const validated = formSchemaValidator.parse(fields);

  await prisma.project.update({
    where: { id: parsed.projectId },
    data:
      parsed.kind === "ICLA"
        ? { claIclaCustomFields: JSON.stringify(validated) }
        : { claCclaCustomFields: JSON.stringify(validated) },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.settings_changed",
    payload: { customFields: parsed.kind, count: validated.length },
  });

  revalidateCla(parsed.projectId);
}

// Per-kind wrappers matching the FormBuilder action contract (FormData carries
// only projectId + schema); they inject the `kind`.
export async function saveIclaCustomFields(formData: FormData) {
  formData.set("kind", "ICLA");
  return saveClaCustomFields(formData);
}
export async function saveCclaCustomFields(formData: FormData) {
  formData.set("kind", "CCLA");
  return saveClaCustomFields(formData);
}

// ---------------------------------------------------------------------------
// CLA settings: mirrors updateGatingSettings (fetch before, update, diff
// audit, revalidate). Checkbox fields are present ("1") => true, absent => false.
// ---------------------------------------------------------------------------
export async function updateClaSettings(formData: FormData) {
  const parsed = claSettingsSchema.parse({
    projectId: formData.get("projectId"),
    claEnabled: formData.get("claEnabled") ?? undefined,
    claRequired: formData.get("claRequired") ?? undefined,
    claCorporateEnabled: formData.get("claCorporateEnabled") ?? undefined,
    claCorporateRequiresApproval:
      formData.get("claCorporateRequiresApproval") ?? undefined,
    claPlacementEmbed: formData.get("claPlacementEmbed") ?? undefined,
    claPlacementStandalone: formData.get("claPlacementStandalone") ?? undefined,
    claAutoVersionRequiresResign:
      formData.get("claAutoVersionRequiresResign") ?? undefined,
    claRepoFileReviewMode: formData.get("claRepoFileReviewMode") ?? undefined,
    claIclaRequireSignature:
      formData.get("claIclaRequireSignature") ?? undefined,
    dcoEnabled: formData.get("dcoEnabled") ?? undefined,
    // Coerce a blank label input to undefined so the existing value is kept
    // (the schema's .min(1) would otherwise reject "").
    labelClaPending:
      typeof formData.get("labelClaPending") === "string" &&
      (formData.get("labelClaPending") as string).trim().length > 0
        ? formData.get("labelClaPending")
        : undefined,
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const before = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      claEnabled: true,
      claRequired: true,
      claCorporateEnabled: true,
      claCorporateRequiresApproval: true,
      claPlacementEmbed: true,
      claPlacementStandalone: true,
      claAutoVersionRequiresResign: true,
      claRepoFileReviewMode: true,
      claIclaRequireSignature: true,
      dcoEnabled: true,
      labelClaPending: true,
      currentIclaVersionId: true,
    },
  });
  if (!before) throw new Error("Project not found");

  const after = {
    claEnabled: !!parsed.claEnabled,
    claRequired: !!parsed.claRequired,
    claCorporateEnabled: !!parsed.claCorporateEnabled,
    claCorporateRequiresApproval: !!parsed.claCorporateRequiresApproval,
    claPlacementEmbed: !!parsed.claPlacementEmbed,
    claPlacementStandalone: !!parsed.claPlacementStandalone,
    claAutoVersionRequiresResign: !!parsed.claAutoVersionRequiresResign,
    claRepoFileReviewMode: !!parsed.claRepoFileReviewMode,
    claIclaRequireSignature: !!parsed.claIclaRequireSignature,
    dcoEnabled: !!parsed.dcoEnabled,
    labelClaPending: parsed.labelClaPending ?? before.labelClaPending,
  };

  await prisma.project.update({
    where: { id: parsed.projectId },
    data: after,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.settings_changed",
    payload: {
      changed: Object.fromEntries(
        Object.entries({
          claEnabled: [before.claEnabled, after.claEnabled],
          claRequired: [before.claRequired, after.claRequired],
          claCorporateEnabled: [
            before.claCorporateEnabled,
            after.claCorporateEnabled,
          ],
          claCorporateRequiresApproval: [
            before.claCorporateRequiresApproval,
            after.claCorporateRequiresApproval,
          ],
          claPlacementEmbed: [
            before.claPlacementEmbed,
            after.claPlacementEmbed,
          ],
          claPlacementStandalone: [
            before.claPlacementStandalone,
            after.claPlacementStandalone,
          ],
          claAutoVersionRequiresResign: [
            before.claAutoVersionRequiresResign,
            after.claAutoVersionRequiresResign,
          ],
          claRepoFileReviewMode: [
            before.claRepoFileReviewMode,
            after.claRepoFileReviewMode,
          ],
          claIclaRequireSignature: [
            before.claIclaRequireSignature,
            after.claIclaRequireSignature,
          ],
          dcoEnabled: [before.dcoEnabled, after.dcoEnabled],
          labelClaPending: [before.labelClaPending, after.labelClaPending],
        }).filter(([, [a, b]]) => a !== b),
      ),
    },
  });

  // Retroactive nudge: when the CLA requirement first turns on and there is
  // already a published ICLA to sign, remind existing applicants (and re-gate
  // approved contributors' open PRs). The "publish the first ICLA" moment is
  // handled in publishClaVersion. Best-effort; never fails the settings save.
  const becameRequired =
    !(before.claEnabled && before.claRequired) &&
    after.claEnabled &&
    after.claRequired;
  if (becameRequired && before.currentIclaVersionId) {
    await sweepUnsignedApplicants({
      projectId: parsed.projectId,
      actorId: session.user.id,
    }).catch(() => undefined);
  }

  revalidateCla(parsed.projectId);
}

// ---------------------------------------------------------------------------
// Publish a new CLA version. For sourceType=repo_file, fetch the file via the
// installation Octokit contents API and use its decoded content as bodyMarkdown
// (+ capture the commit sha). For manual, use the pasted bodyMarkdown.
// ---------------------------------------------------------------------------
export async function publishClaVersion(formData: FormData) {
  // Optional text inputs post "" when left blank; coerce blanks to undefined so
  // `.min(1).optional()` fields (e.g. an empty "Ref") validate as absent.
  const opt = (key: string) => {
    const v = formData.get(key);
    return typeof v === "string" && v.trim().length > 0 ? v : undefined;
  };
  const resignVersionIds = formData
    .getAll("resignVersionIds")
    .map((v) => String(v))
    .filter((v) => v.length > 0);
  const parsed = publishVersionSchema.parse({
    projectId: formData.get("projectId"),
    kind: formData.get("kind"),
    sourceType: formData.get("sourceType"),
    bodyMarkdown: opt("bodyMarkdown"),
    sourceRepoId: opt("sourceRepoId"),
    sourcePath: opt("sourcePath"),
    sourceRef: opt("sourceRef"),
    requireResign: formData.get("requireResign") ?? false,
    resignVersionIds:
      resignVersionIds.length > 0 ? resignVersionIds : undefined,
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  // Capture whether an ICLA already existed BEFORE publishing: the publish
  // mutation overwrites currentIclaVersionId, and the prior value detects the
  // "first ICLA" moment that first makes the CLA signable for applicants.
  const projectBefore = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: {
      claEnabled: true,
      claRequired: true,
      currentIclaVersionId: true,
    },
  });

  // Validate any selected prior versions belong to this project + kind, so the
  // per-version selection can't reference another project's versions.
  if (parsed.resignVersionIds && parsed.resignVersionIds.length > 0) {
    const owned = await prisma.claDocumentVersion.count({
      where: {
        id: { in: parsed.resignVersionIds },
        projectId: parsed.projectId,
        kind: parsed.kind,
      },
    });
    if (owned !== parsed.resignVersionIds.length) {
      throw new Error("A selected version does not belong to this CLA.");
    }
  }

  let bodyMarkdown: string;
  let sourceRepoId: string | null = null;
  let sourcePath: string | null = null;
  let sourceRef: string | null = null;
  let sourceCommitSha: string | null = null;

  if (parsed.sourceType === "repo_file") {
    if (!parsed.sourceRepoId || !parsed.sourcePath) {
      throw new Error(
        "Repo and file path are required for a repo-file source.",
      );
    }
    const repo = await prisma.repo.findUnique({
      where: { id: parsed.sourceRepoId },
      select: {
        id: true,
        projectId: true,
        fullName: true,
        installationId: true,
      },
    });
    if (!repo || repo.projectId !== parsed.projectId) {
      throw new Error("Repository not found for this project.");
    }
    if (!repo.installationId) {
      throw new Error(
        "The GitHub App is not installed on this repository yet, so the file cannot be fetched.",
      );
    }
    const fetched = await fetchRepoFile({
      installationId: repo.installationId,
      fullName: repo.fullName,
      path: parsed.sourcePath,
      ref: parsed.sourceRef,
    });
    if (!fetched) {
      throw new Error(
        `Could not read ${parsed.sourcePath} from ${repo.fullName}. Check the path and ref.`,
      );
    }
    if (!fetched.content.trim()) {
      throw new Error("The fetched file is empty.");
    }
    bodyMarkdown = fetched.content;
    sourceCommitSha = fetched.sha;
    sourceRepoId = repo.id;
    sourcePath = parsed.sourcePath;
    sourceRef = parsed.sourceRef ?? null;
  } else {
    if (!parsed.bodyMarkdown || !parsed.bodyMarkdown.trim()) {
      throw new Error("The CLA text cannot be empty.");
    }
    bodyMarkdown = parsed.bodyMarkdown;
  }

  const published = await claMutations.publishClaVersion({
    projectId: parsed.projectId,
    kind: parsed.kind,
    bodyMarkdown,
    sourceType: parsed.sourceType,
    sourceRepoId,
    sourcePath,
    sourceRef,
    sourceCommitSha,
    requireResign: parsed.requireResign,
    resignVersionIds: parsed.resignVersionIds,
    actorUserId: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.version_published",
    payload: {
      kind: parsed.kind,
      version: published.version,
      contentHash: published.contentHash,
      sourceType: parsed.sourceType,
      requireResign: parsed.requireResign,
      resignVersionIds: parsed.resignVersionIds ?? [],
    },
  });

  // A publish only ever makes PRIOR signers stale (the new version has no
  // signers yet), so re-gate the affected contributors' open passing PRs.
  await driveCoverage(parsed.projectId, published.affectedGhIds);

  // First ICLA published while the CLA is required: retroactively remind
  // existing applicants now that there is finally something to sign. (The
  // enable-toggle path covers the case where a version already existed.) Only
  // ICLA gates individuals; a CCLA publish never creates newly-uncovered
  // individuals. Best-effort.
  if (
    parsed.kind === "ICLA" &&
    projectBefore?.claEnabled &&
    projectBefore.claRequired &&
    !projectBefore.currentIclaVersionId
  ) {
    await sweepUnsignedApplicants({
      projectId: parsed.projectId,
      actorId: session.user.id,
    }).catch(() => undefined);
  }

  revalidateCla(parsed.projectId);
}

// ---------------------------------------------------------------------------
// Admin signature revocation.
// ---------------------------------------------------------------------------
export async function revokeSignature(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const signatureId = String(formData.get("signatureId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!projectId || !signatureId) {
    throw new Error("Missing signature reference.");
  }
  if (!reason) throw new Error("A revocation reason is required.");

  const { session } = await requireProjectRole(projectId, "ADMIN");

  const sig = await prisma.claSignature.findUnique({
    where: { id: signatureId },
    select: { projectId: true },
  });
  if (!sig || sig.projectId !== projectId) {
    throw new Error("Signature not found for this project.");
  }

  await claMutations.revokeSignature({
    signatureId,
    actorUserId: session.user.id,
    reason,
  });

  await recordAudit({
    projectId,
    actorId: session.user.id,
    kind: "cla.signature_revoked",
    payload: { signatureId, reason },
  });

  revalidatePath(`/dashboard/projects/${projectId}/cla/signatures`);
  revalidateCla(projectId);
}

// ---------------------------------------------------------------------------
// Admin CLA waiver (exemption) grant / revoke.
// ---------------------------------------------------------------------------
export async function grantWaiver(formData: FormData) {
  const parsed = waiverSchema.parse({
    projectId: formData.get("projectId"),
    ghLogin: formData.get("ghLogin"),
    reason: formData.get("reason"),
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  // Capture the stable numeric id if we know this account, so the waiver also
  // matches by ghId (survives a login rename), not only by login.
  const existingUser = await prisma.user.findUnique({
    where: { ghLogin: parsed.ghLogin.toLowerCase() },
    select: { ghId: true },
  });

  const waiver = await claMutations.grantWaiver({
    projectId: parsed.projectId,
    ghLogin: parsed.ghLogin,
    ghId: existingUser?.ghId ?? null,
    reason: parsed.reason,
    actorUserId: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.waiver_granted",
    payload: {
      waiverId: waiver.id,
      ghLogin: parsed.ghLogin,
      reason: parsed.reason,
    },
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/cla/signatures`);
  revalidateCla(parsed.projectId);
}

export async function revokeWaiver(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const waiverId = String(formData.get("waiverId") ?? "");
  if (!projectId || !waiverId) throw new Error("Missing waiver reference.");

  const { session } = await requireProjectRole(projectId, "ADMIN");

  const waiver = await prisma.claWaiver.findUnique({
    where: { id: waiverId },
    select: { projectId: true },
  });
  if (!waiver || waiver.projectId !== projectId) {
    throw new Error("Waiver not found for this project.");
  }

  await claMutations.revokeWaiver({ waiverId, actorUserId: session.user.id });

  await recordAudit({
    projectId,
    actorId: session.user.id,
    kind: "cla.waiver_revoked",
    payload: { waiverId },
  });

  revalidatePath(`/dashboard/projects/${projectId}/cla/signatures`);
  revalidateCla(projectId);
}

// ---------------------------------------------------------------------------
// Retroactively toggle a single already-published version's resignRequired flag
// (the per-version control in Version history). Drives coverage in both
// directions for affected contributors.
// ---------------------------------------------------------------------------
export async function setVersionResign(formData: FormData) {
  const truthy = (v: FormDataEntryValue | null) =>
    ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());
  const parsed = setVersionResignSchema.parse({
    projectId: formData.get("projectId"),
    changes: [
      {
        versionId: formData.get("versionId"),
        resignRequired: truthy(formData.get("resignRequired")),
      },
    ],
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const result = await claMutations.setVersionResign({
    projectId: parsed.projectId,
    changes: parsed.changes,
    actorUserId: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.version_resign_changed",
    payload: { changes: parsed.changes },
  });

  await driveCoverage(parsed.projectId, result.affectedGhIds);

  revalidateCla(parsed.projectId);
}

// ---------------------------------------------------------------------------
// Review & approve: approve or reject a detected repo-file change.
// ---------------------------------------------------------------------------
export async function approvePendingChange(formData: FormData) {
  const resignVersionIds = formData
    .getAll("resignVersionIds")
    .map((v) => String(v))
    .filter((v) => v.length > 0);
  const parsed = approvePendingChangeSchema.parse({
    projectId: formData.get("projectId"),
    pendingChangeId: formData.get("pendingChangeId"),
    requireResign: formData.get("requireResign") ?? false,
    resignVersionIds:
      resignVersionIds.length > 0 ? resignVersionIds : undefined,
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const pending = await prisma.claPendingChange.findUnique({
    where: { id: parsed.pendingChangeId },
    select: {
      id: true,
      projectId: true,
      kind: true,
      status: true,
      sourceRepoId: true,
      sourcePath: true,
      sourceRef: true,
      detectedCommitSha: true,
      detectedContent: true,
      contentHash: true,
    },
  });
  if (!pending || pending.projectId !== parsed.projectId) {
    throw new Error("Pending change not found for this project.");
  }
  if (pending.status !== "PENDING") {
    throw new Error("This change has already been resolved.");
  }

  // Stale-HEAD guard: refuse if the file changed on the branch since detection.
  const repo = await prisma.repo.findUnique({
    where: { id: pending.sourceRepoId },
    select: { id: true, fullName: true, installationId: true },
  });
  if (!repo || repo.installationId == null) {
    throw new Error("The source repo has no GitHub App installation.");
  }
  const head = await fetchRepoFile({
    installationId: repo.installationId,
    fullName: repo.fullName,
    path: pending.sourcePath,
    ref: pending.sourceRef,
  });
  if (!head || sha256Hex(head.content) !== pending.contentHash) {
    throw new Error(
      "The file changed on the branch since this was queued. Re-sync and review the latest version.",
    );
  }

  const kind = pending.kind as "ICLA" | "CCLA";
  if (parsed.resignVersionIds && parsed.resignVersionIds.length > 0) {
    const owned = await prisma.claDocumentVersion.count({
      where: {
        id: { in: parsed.resignVersionIds },
        projectId: parsed.projectId,
        kind,
      },
    });
    if (owned !== parsed.resignVersionIds.length) {
      throw new Error("A selected version does not belong to this CLA.");
    }
  }

  const published = await claMutations.publishClaVersion({
    projectId: parsed.projectId,
    kind,
    bodyMarkdown: pending.detectedContent,
    sourceType: "repo_file",
    sourceRepoId: pending.sourceRepoId,
    sourcePath: pending.sourcePath,
    sourceRef: pending.sourceRef,
    sourceCommitSha: pending.detectedCommitSha,
    requireResign: parsed.requireResign,
    resignVersionIds: parsed.resignVersionIds,
    resolvePendingChangeId: pending.id,
    actorUserId: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.pending_change_approved",
    payload: {
      pendingChangeId: pending.id,
      kind,
      version: published.version,
      requireResign: parsed.requireResign,
      resignVersionIds: parsed.resignVersionIds ?? [],
    },
  });

  await driveCoverage(parsed.projectId, published.affectedGhIds);

  revalidateCla(parsed.projectId);
}

export async function rejectPendingChange(formData: FormData) {
  const parsed = rejectPendingChangeSchema.parse({
    projectId: formData.get("projectId"),
    pendingChangeId: formData.get("pendingChangeId"),
    reason: formData.get("reason") ?? undefined,
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  const pending = await prisma.claPendingChange.findUnique({
    where: { id: parsed.pendingChangeId },
    select: { id: true, projectId: true, status: true },
  });
  if (!pending || pending.projectId !== parsed.projectId) {
    throw new Error("Pending change not found for this project.");
  }
  if (pending.status !== "PENDING") {
    throw new Error("This change has already been resolved.");
  }

  await prisma.claPendingChange.update({
    where: { id: pending.id },
    data: {
      status: "REJECTED",
      reviewedById: session.user.id,
      reviewedAt: new Date(),
      rejectReason: parsed.reason ?? null,
    },
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.pending_change_rejected",
    payload: { pendingChangeId: pending.id, reason: parsed.reason ?? "" },
  });

  revalidateCla(parsed.projectId);
}

// ---------------------------------------------------------------------------
// Manual "Sync now": admin-initiated re-fetch of the repo-file source(s),
// rate-limited and returning a structured per-kind result.
// ---------------------------------------------------------------------------
export async function runClaRepoSync(
  projectId: string,
  kind?: "ICLA" | "CCLA",
): Promise<{ results: SyncOutcome[] }> {
  await requireProjectRole(projectId, "ADMIN");

  const limited = await rateLimit({
    key: `cla-sync:${projectId}`,
    limit: 6,
    windowMs: 60_000,
  });
  if (!limited.ok) {
    throw new Error("Too many syncs. Please wait a minute and try again.");
  }

  const out = await syncClaRepoSourceNowCore({ projectId, kind });
  revalidateCla(projectId);
  return out;
}

// ---------------------------------------------------------------------------
// Read helpers for the admin UI (ADMIN-gated server reads).
// ---------------------------------------------------------------------------

/**
 * For the current version of a kind, report the live repo file content and
 * whether it matches the stored (published) version, for the drift indicator.
 */
export async function fetchClaRepoSource(
  projectId: string,
  kind: "ICLA" | "CCLA",
): Promise<RepoSourceView> {
  await requireProjectRole(projectId, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { currentIclaVersionId: true, currentCclaVersionId: true },
  });
  const versionId =
    kind === "ICLA"
      ? project?.currentIclaVersionId
      : project?.currentCclaVersionId;
  if (!versionId) return { sourced: false };

  const version = await prisma.claDocumentVersion.findUnique({
    where: { id: versionId },
    select: {
      sourceType: true,
      sourceRepoId: true,
      sourcePath: true,
      sourceRef: true,
      sourceCommitSha: true,
      contentHash: true,
    },
  });
  if (
    !version ||
    version.sourceType !== "repo_file" ||
    !version.sourceRepoId ||
    !version.sourcePath
  ) {
    return { sourced: false };
  }

  const repo = await prisma.repo.findUnique({
    where: { id: version.sourceRepoId },
    select: { fullName: true, installationId: true },
  });
  const base = {
    sourced: true as const,
    fullName: repo?.fullName ?? "",
    sourcePath: version.sourcePath,
    sourceRef: version.sourceRef,
    storedCommitSha: version.sourceCommitSha,
  };
  if (!repo || repo.installationId == null) {
    return { ...base, available: false };
  }

  const fetched = await fetchRepoFile({
    installationId: repo.installationId,
    fullName: repo.fullName,
    path: version.sourcePath,
    ref: version.sourceRef,
  });
  if (!fetched) {
    return { ...base, available: false };
  }
  const liveHash = sha256Hex(fetched.content);
  return {
    ...base,
    available: true,
    content: fetched.content,
    liveSha: fetched.sha,
    storedHash: version.contentHash,
    liveHash,
    matchesStored: liveHash === version.contentHash,
  };
}

/** Preview a repo file's content before publishing (editor "Preview" button). */
export async function previewRepoFile(args: {
  projectId: string;
  sourceRepoId: string;
  path: string;
  ref?: string | null;
}): Promise<
  | { ok: true; content: string; sha: string | null }
  | { ok: false; error: string }
> {
  await requireProjectRole(args.projectId, "ADMIN");

  const repo = await prisma.repo.findUnique({
    where: { id: args.sourceRepoId },
    select: { projectId: true, fullName: true, installationId: true },
  });
  if (!repo || repo.projectId !== args.projectId) {
    return { ok: false, error: "Repository not found for this project." };
  }
  if (repo.installationId == null) {
    return {
      ok: false,
      error: "The GitHub App is not installed on this repo.",
    };
  }
  const fetched = await fetchRepoFile({
    installationId: repo.installationId,
    fullName: repo.fullName,
    path: args.path,
    ref: args.ref,
  });
  if (!fetched) {
    return {
      ok: false,
      error: `Could not read ${args.path} from ${repo.fullName}.`,
    };
  }
  return { ok: true, content: fetched.content, sha: fetched.sha };
}

/** Read a historical version's stored body for the Version history preview. */
export async function getClaVersionBody(
  projectId: string,
  versionId: string,
): Promise<{ bodyMarkdown: string }> {
  await requireProjectRole(projectId, "ADMIN");
  const version = await prisma.claDocumentVersion.findUnique({
    where: { id: versionId },
    select: { projectId: true, bodyMarkdown: true },
  });
  if (!version || version.projectId !== projectId) {
    throw new Error("Version not found for this project.");
  }
  return { bodyMarkdown: version.bodyMarkdown };
}

// ---------------------------------------------------------------------------
// Manually remind unsigned applicants. Sweeps SUBMITTED + APPROVED applicants
// who are not CLA-covered, sending in-app + email reminders (and re-gating
// approved contributors' open PRs, deduping any reminder already on the PR).
// Bounded to 200 applications per run and idempotent, so it is safe to press
// repeatedly. Mirrors the quality "Backfill" admin action.
// ---------------------------------------------------------------------------
export async function notifyUnsignedApplicants(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) throw new Error("Missing project.");

  const { session } = await requireProjectRole(projectId, "ADMIN");

  await sweepUnsignedApplicants({ projectId, actorId: session.user.id });

  revalidateCla(projectId);
}
