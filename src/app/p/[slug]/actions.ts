"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { submitApplication } from "@/lib/applications/lifecycle";
import { notifyAdminsOfNewApplication } from "@/lib/applications/decide";
import { parseFormSchema, type FormSchema } from "@/lib/applications/schema";
import { signIclaSchema } from "@/lib/cla/schema";
import { getClaStatus, invalidateClaCache } from "@/lib/cla/status";
import { recordIclaSignature } from "@/lib/cla/mutations";
import { onClaCoverageChanged } from "@/lib/cla/post-sign";
import { getClientIp, getClientUserAgent } from "@/lib/http/client";
import type { ApplyState } from "./apply-form";

// Verbatim affirmation snapshotted onto the immutable click-wrap signature.
const CLA_EMBED_AFFIRMATION =
  "I have read and agree to the Contributor License Agreement, and I am " +
  "signing it as the GitHub account I am authenticated with.";

function collectAnswers(
  formData: FormData,
  fields: FormSchema
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    if (f.type === "checkbox") {
      out[f.id] = formData.get(f.id) !== null;
    } else {
      const v = formData.get(f.id);
      out[f.id] = typeof v === "string" ? v : "";
    }
  }
  return out;
}

export async function applyAction(
  _prev: ApplyState,
  formData: FormData
): Promise<ApplyState> {
  const session = await auth();
  if (!session?.user) {
    return { status: "error", reason: "Sign in with GitHub first." };
  }

  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) {
    return { status: "error", reason: "Missing project." };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      slug: true,
      formSchema: true,
      claEnabled: true,
      claRequired: true,
      claPlacementEmbed: true,
      currentIclaVersionId: true,
    },
  });
  if (!project) return { status: "error", reason: "Project not found." };

  const fields = parseFormSchema(project.formSchema);
  // Echo what the user submitted on every error path so the form can
  // re-populate without losing input on validation failure. `cla_*` fields
  // live in a reserved namespace outside the form schema and are deliberately
  // never echoed — the signature is captured fresh, never restored.
  const submitted = collectAnswers(formData, fields);

  // Determine whether an embedded CLA signature is required for THIS
  // submission. Mirrors the page-side gate (claEnabled && claRequired &&
  // claPlacementEmbed && a published ICLA version && not already covered).
  // Re-checked server-side so a stale/forged client cannot skip signing.
  const ghId = session.user.ghId;
  const ghLogin = session.user.ghLogin;
  let claRequiredForSubmission = false;
  if (
    project.claEnabled &&
    project.claRequired &&
    project.claPlacementEmbed &&
    project.currentIclaVersionId &&
    typeof ghId === "number" &&
    ghLogin
  ) {
    const status = await getClaStatus({
      projectId: project.id,
      ghId,
      ghLogin,
    });
    claRequiredForSubmission = !status.satisfied;
  }

  // Validate the click-wrap acceptance (agree + legal name) up front so the
  // user gets the error without consuming a rate-limit slot or touching the DB
  // beyond the coverage read above.
  let claLegalName = "";
  if (claRequiredForSubmission) {
    const claParsed = signIclaSchema
      .pick({ legalName: true, agree: true })
      .safeParse({
        legalName: String(formData.get("cla_legalName") ?? ""),
        agree: formData.get("cla_agree") !== null,
      });
    if (!claParsed.success) {
      return {
        status: "error",
        reason:
          "You must accept the Contributor License Agreement and provide your full legal name.",
        values: submitted,
      };
    }
    claLegalName = claParsed.data.legalName;
  }

  // Rate limit by user (5/hr) and IP (20/hr).
  const userLimit = await rateLimit({
    key: `apply:user:${session.user.id}`,
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!userLimit.ok) {
    return {
      status: "error",
      reason: "Too many submissions. Try again later.",
      values: submitted,
    };
  }
  const headerList = await headers();
  const ip = getClientIp(headerList);
  const userAgent = getClientUserAgent(headerList);
  const ipLimit = await rateLimit({
    key: `apply:ip:${ip}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!ipLimit.ok) {
    return {
      status: "error",
      reason: "Too many submissions from your network. Try again later.",
      values: submitted,
    };
  }

  // Re-verify the current ICLA version server-side at submit time, so a
  // version published between page render and submit binds the signature to
  // the version the project actually has live now.
  let signedVersionId: string | null = null;
  if (claRequiredForSubmission) {
    const current = await prisma.project.findUnique({
      where: { id: project.id },
      select: { currentIclaVersionId: true },
    });
    signedVersionId = current?.currentIclaVersionId ?? null;
    if (!signedVersionId) {
      return {
        status: "error",
        reason:
          "The Contributor License Agreement is not available right now. Please try again later.",
        values: submitted,
      };
    }
  }

  const result =
    claRequiredForSubmission && typeof ghId === "number" && ghLogin
      ? await prisma.$transaction((tx) =>
          submitApplication({
            userId: session.user!.id,
            projectId: project.id,
            rawAnswers: submitted,
            tx,
            afterCreate: async (application, innerTx) => {
              // Atomic: the application and the immutable click-wrap signature
              // commit together (recordIclaSignature also appends the
              // icla.signed ledger entry inside this same transaction).
              await recordIclaSignature({
                projectId: project.id,
                userId: session.user!.id,
                ghId,
                ghLogin,
                emailSnapshot: session.user!.email ?? null,
                legalName: claLegalName,
                affirmation: CLA_EMBED_AFFIRMATION,
                ip,
                userAgent,
                applicationId: application.id,
                tx: innerTx,
              });
            },
          })
        )
      : await submitApplication({
          userId: session.user.id,
          projectId: project.id,
          rawAnswers: submitted,
        });

  if (!result.ok) {
    return { status: "error", reason: result.reason, values: submitted };
  }

  // Coverage changed: drop the cache and re-check the contributor's open
  // CLA-gated PRs (re-publishes passing Checks / swaps labels for any now
  // allowed). Best-effort — never blocks the submission response.
  if (claRequiredForSubmission && typeof ghId === "number") {
    invalidateClaCache(project.id, ghId);
    try {
      await onClaCoverageChanged({ projectId: project.id, ghId });
    } catch {
      // Non-fatal: the regular decision pipeline / sweep will catch up.
    }
  }

  await notifyAdminsOfNewApplication({ applicationId: result.applicationId });

  revalidatePath(`/p/${project.slug}`);
  return { status: "ok", applicationId: result.applicationId };
}
