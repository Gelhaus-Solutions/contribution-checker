"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { requireProjectRole } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { getInstallationOctokit } from "@/lib/github/app";
import {
  claSettingsSchema,
  publishVersionSchema,
  waiverSchema,
  saveCustomFieldsSchema,
} from "@/lib/cla/schema";
import { formSchema as formSchemaValidator } from "@/lib/applications/schema";
import * as claMutations from "@/lib/cla/mutations";

function revalidateCla(projectId: string) {
  revalidatePath(`/dashboard/projects/${projectId}/cla`);
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
// CLA settings — mirrors updateGatingSettings (fetch before, update, diff
// audit, revalidate). Checkbox fields are present ("1") => true, absent => false.
// ---------------------------------------------------------------------------
export async function updateClaSettings(formData: FormData) {
  const parsed = claSettingsSchema.parse({
    projectId: formData.get("projectId"),
    claEnabled: formData.get("claEnabled") ?? undefined,
    claRequired: formData.get("claRequired") ?? undefined,
    claCorporateEnabled: formData.get("claCorporateEnabled") ?? undefined,
    claPlacementEmbed: formData.get("claPlacementEmbed") ?? undefined,
    claPlacementStandalone: formData.get("claPlacementStandalone") ?? undefined,
    claAutoVersionRequiresResign:
      formData.get("claAutoVersionRequiresResign") ?? undefined,
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
      claPlacementEmbed: true,
      claPlacementStandalone: true,
      claAutoVersionRequiresResign: true,
      claIclaRequireSignature: true,
      dcoEnabled: true,
      labelClaPending: true,
    },
  });
  if (!before) throw new Error("Project not found");

  const after = {
    claEnabled: !!parsed.claEnabled,
    claRequired: !!parsed.claRequired,
    claCorporateEnabled: !!parsed.claCorporateEnabled,
    claPlacementEmbed: !!parsed.claPlacementEmbed,
    claPlacementStandalone: !!parsed.claPlacementStandalone,
    claAutoVersionRequiresResign: !!parsed.claAutoVersionRequiresResign,
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
          claIclaRequireSignature: [
            before.claIclaRequireSignature,
            after.claIclaRequireSignature,
          ],
          dcoEnabled: [before.dcoEnabled, after.dcoEnabled],
          labelClaPending: [before.labelClaPending, after.labelClaPending],
        }).filter(([, [a, b]]) => a !== b)
      ),
    },
  });

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
  const parsed = publishVersionSchema.parse({
    projectId: formData.get("projectId"),
    kind: formData.get("kind"),
    sourceType: formData.get("sourceType"),
    bodyMarkdown: opt("bodyMarkdown"),
    sourceRepoId: opt("sourceRepoId"),
    sourcePath: opt("sourcePath"),
    sourceRef: opt("sourceRef"),
    requireResign: formData.get("requireResign") ?? false,
  });

  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");

  let bodyMarkdown: string;
  let sourceRepoId: string | null = null;
  let sourcePath: string | null = null;
  let sourceRef: string | null = null;
  let sourceCommitSha: string | null = null;

  if (parsed.sourceType === "repo_file") {
    if (!parsed.sourceRepoId || !parsed.sourcePath) {
      throw new Error("Repo and file path are required for a repo-file source.");
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
        "The GitHub App is not installed on this repository yet — cannot fetch the file."
      );
    }
    const [owner, name] = repo.fullName.split("/");
    if (!owner || !name) throw new Error("Repository name is malformed.");

    const octokit = await getInstallationOctokit(repo.installationId);
    let decoded: string;
    try {
      const res = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner,
          repo: name,
          path: parsed.sourcePath,
          ...(parsed.sourceRef ? { ref: parsed.sourceRef } : {}),
        }
      );
      const data = res.data as {
        type?: string;
        content?: string;
        encoding?: string;
        sha?: string;
      };
      if (Array.isArray(data) || data.type !== "file" || !data.content) {
        throw new Error("Path does not point to a file.");
      }
      decoded = Buffer.from(
        data.content,
        (data.encoding as BufferEncoding) ?? "base64"
      ).toString("utf8");
      sourceCommitSha = data.sha ?? null;
    } catch (err) {
      logger.warn(
        { err, repo: repo.fullName, path: parsed.sourcePath },
        "cla: failed to fetch repo file for publish"
      );
      throw new Error(
        `Could not read ${parsed.sourcePath} from ${repo.fullName}. Check the path and ref.`
      );
    }
    if (!decoded.trim()) {
      throw new Error("The fetched file is empty.");
    }
    bodyMarkdown = decoded;
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
    },
  });

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

  const waiver = await claMutations.grantWaiver({
    projectId: parsed.projectId,
    ghLogin: parsed.ghLogin,
    reason: parsed.reason,
    actorUserId: session.user.id,
  });

  await recordAudit({
    projectId: parsed.projectId,
    actorId: session.user.id,
    kind: "cla.waiver_granted",
    payload: { waiverId: waiver.id, ghLogin: parsed.ghLogin, reason: parsed.reason },
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
