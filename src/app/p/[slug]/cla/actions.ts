"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { recordAudit } from "@/lib/audit";
import { notifyProjectReviewers } from "@/lib/notifications/inbox";
import { sendEmail } from "@/lib/notifications/email";
import { logger } from "@/lib/logger";
import { getClientIp, getClientUserAgent } from "@/lib/http/client";
import {
  signIclaSchema,
  signCclaSchema,
  signatureSchema,
  collectSignature,
  rosterAddSchema,
  rosterRevokeSchema,
  disputeSchema,
  collectClaCustomAnswers,
} from "@/lib/cla/schema";
import type { ClaSignatureCapture } from "@/lib/cla/mutations";
import {
  parseFormSchema,
  buildAnswersSchema,
} from "@/lib/applications/schema";
import {
  recordIclaSignature,
  recordCclaSignature,
  addRosterMembers as addRosterMembersMutation,
  revokeRosterMember as revokeRosterMemberMutation,
  disputeRosterMembership,
} from "@/lib/cla/mutations";
import { onClaCoverageChanged } from "@/lib/cla/post-sign";

// ---------------------------------------------------------------------------
// Public, GitHub-sign-in-gated CLA actions. Mirrors `applyAction`:
//   - `await auth()` (reject if no signed-in user / no GitHub identity);
//   - rate limit by user (5/hr) and IP (20/hr);
//   - read IP/UA via `getClientIp`/`getClientUserAgent(await headers())`;
//   - re-fetch the project + current document version SERVER-SIDE (never trust
//     the client-supplied version/contentHash);
//   - validate FormData with the `@/lib/cla/schema` validators;
//   - build the exact affirmation string the contributor saw;
//   - delegate the DB write + ledger append to the `@/lib/cla/mutations`
//     helpers (each runs in its own `$transaction` + appends a ledger entry);
//   - re-check the contributor's open CLA-gated PRs for coverage-granting
//     actions (`onClaCoverageChanged`), audit, and notify.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

export type ClaActionState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; reason: string };

type SessionUser = {
  id: string;
  ghId: number;
  ghLogin: string;
  email: string | null;
};

type RateLimited =
  | { ok: true; user: SessionUser; ip: string; userAgent: string }
  | { ok: false; reason: string };

/**
 * Shared gate: require an authenticated GitHub user, then rate-limit by user
 * (5/hr) and IP (20/hr) exactly like `applyAction`. Returns the resolved
 * identity + request metadata on success.
 */
async function gate(): Promise<RateLimited> {
  const session = await auth();
  const user = session?.user;
  if (!user) {
    return { ok: false, reason: "Log in first." };
  }
  if (user.restricted) {
    return { ok: false, reason: "Your account is restricted." };
  }
  if (typeof user.ghId !== "number" || !user.ghLogin) {
    return {
      ok: false,
      reason: "Your GitHub identity is incomplete. Sign out and back in.",
    };
  }

  const userLimit = await rateLimit({
    key: `cla:sign:user:${user.id}`,
    limit: 5,
    windowMs: HOUR_MS,
  });
  if (!userLimit.ok) {
    return { ok: false, reason: "Too many submissions. Try again later." };
  }

  const h = await headers();
  const ip = getClientIp(h);
  const ipLimit = await rateLimit({
    key: `cla:sign:ip:${ip}`,
    limit: 20,
    windowMs: HOUR_MS,
  });
  if (!ipLimit.ok) {
    return {
      ok: false,
      reason: "Too many submissions from your network. Try again later.",
    };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      ghId: user.ghId,
      ghLogin: user.ghLogin,
      email: user.email ?? null,
    },
    ip,
    userAgent: getClientUserAgent(h),
  };
}

function fail(reason: string): ClaActionState {
  return { status: "error", reason };
}

/**
 * Build the verbatim affirmation snapshot stored on the signature and the
 * ledger. Binds the typed legal name + GitHub identity + the exact document
 * version & content hash so the record is self-describing and tamper-evident.
 */
function buildAffirmation(args: {
  kind: "ICLA" | "CCLA";
  legalName: string;
  ghLogin: string;
  version: number;
  contentHash: string;
  companyName?: string;
}): string {
  const doc = args.kind === "ICLA" ? "Individual" : "Corporate";
  const corp = args.companyName
    ? ` on behalf of ${args.companyName}`
    : "";
  return (
    `I, ${args.legalName} (GitHub @${args.ghLogin})${corp}, have read and ` +
    `agree to be legally bound by the ${doc} Contributor License Agreement ` +
    `version ${args.version} (content hash ${args.contentHash}).`
  );
}

/**
 * Sign the project's current ICLA. Records an immutable signature + ledger
 * entry, then re-checks any of the contributor's PRs being held open behind a
 * CLA Check so they clear automatically.
 */
export async function signIcla(
  _prev: ClaActionState,
  formData: FormData
): Promise<ClaActionState> {
  const gated = await gate();
  if (!gated.ok) return fail(gated.reason);
  const { user, ip, userAgent } = gated;

  const parsed = signIclaSchema.safeParse({
    projectId: String(formData.get("projectId") ?? ""),
    legalName: String(formData.get("legalName") ?? ""),
    agree: formData.get("agree") != null,
    applicationId: formData.get("applicationId")
      ? String(formData.get("applicationId"))
      : undefined,
  });
  if (!parsed.success) {
    return fail("Please type your full legal name and check the agreement box.");
  }
  const input = parsed.data;

  // Re-fetch project + current ICLA version server-side; never trust the
  // version/contentHash the client may have submitted.
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: {
      id: true,
      slug: true,
      claEnabled: true,
      claIclaRequireSignature: true,
      claIclaCustomFields: true,
      currentIclaVersionId: true,
    },
  });
  if (!project) return fail("Project not found.");
  if (!project.claEnabled) return fail("This project does not require a CLA.");
  if (!project.currentIclaVersionId) {
    return fail("No CLA has been published for this project yet.");
  }

  // The signer's full legal name is always required. A drawn/typed/uploaded
  // signature artifact is additionally required only when the project opts in.
  if (input.legalName.length < 2) {
    return fail("Please enter your full legal name.");
  }
  let signature: ClaSignatureCapture | null = null;
  if (project.claIclaRequireSignature) {
    const sig = signatureSchema.safeParse(collectSignature(formData));
    if (!sig.success) {
      return fail("Please provide a signature: type, draw, or upload one.");
    }
    signature = {
      kind: sig.data.signatureKind,
      text: sig.data.signatureText ?? null,
      image: sig.data.signatureImage ?? null,
    };
  }

  // Collect + validate admin-defined custom fields.
  const customFieldDefs = parseFormSchema(project.claIclaCustomFields);
  let customFields: Record<string, string | boolean> | null = null;
  if (customFieldDefs.length > 0) {
    const raw = collectClaCustomAnswers(formData, customFieldDefs);
    const ans = buildAnswersSchema(customFieldDefs).safeParse(raw);
    if (!ans.success) {
      return fail("Please complete the required fields on the CLA form.");
    }
    customFields = ans.data as Record<string, string | boolean>;
  }

  const version = await prisma.claDocumentVersion.findUnique({
    where: { id: project.currentIclaVersionId },
    select: { version: true, contentHash: true, kind: true },
  });
  if (!version || version.kind !== "ICLA") {
    return fail("The current CLA version is unavailable. Try again shortly.");
  }

  const affirmation = buildAffirmation({
    kind: "ICLA",
    legalName: input.legalName || `GitHub @${user.ghLogin}`,
    ghLogin: user.ghLogin,
    version: version.version,
    contentHash: version.contentHash,
  });

  try {
    const sig = await recordIclaSignature({
      projectId: project.id,
      userId: user.id,
      ghId: user.ghId,
      ghLogin: user.ghLogin,
      emailSnapshot: user.email,
      legalName: input.legalName,
      affirmation,
      signature,
      customFields,
      ip,
      userAgent,
      applicationId: input.applicationId ?? null,
    });

    await onClaCoverageChanged({ projectId: project.id, ghId: user.ghId });

    await recordAudit({
      projectId: project.id,
      actorId: user.id,
      kind: "cla.signed",
      payload: {
        signatureId: sig.id,
        ghId: user.ghId,
        ghLogin: user.ghLogin,
        documentVersion: version.version,
      },
    });
  } catch (e) {
    logger.warn({ err: e, projectId: project.id }, "icla sign failed");
    return fail("Could not record your signature. Please try again.");
  }

  revalidatePath(`/p/${project.slug}/cla`);
  revalidatePath(`/p/${project.slug}`);
  return { status: "ok" };
}

/**
 * Sign a Corporate CLA. Creates the signatory's signature + the CorporateCla
 * company record, then notifies the project's reviewers (CCLA is noisy by
 * design, unlike routine ICLA signs).
 */
export async function signCcla(
  _prev: ClaActionState,
  formData: FormData
): Promise<ClaActionState> {
  const gated = await gate();
  if (!gated.ok) return fail(gated.reason);
  const { user, ip, userAgent } = gated;

  const parsed = signCclaSchema.safeParse({
    projectId: String(formData.get("projectId") ?? ""),
    legalName: String(formData.get("legalName") ?? ""),
    agree: formData.get("agree") != null,
    companyName: String(formData.get("companyName") ?? ""),
    registeredAddress: String(formData.get("registeredAddress") ?? ""),
    country: String(formData.get("country") ?? ""),
    contactName: String(formData.get("contactName") ?? ""),
    contactEmail: String(formData.get("contactEmail") ?? ""),
    signatoryTitle: String(formData.get("signatoryTitle") ?? ""),
  });
  if (!parsed.success) {
    return fail(
      "Please complete the full corporate signature block (legal entity, registered address, country, point of contact, authorized representative, and title) and check the agreement box."
    );
  }
  const input = parsed.data;

  // The corporate signature (type/draw/upload) is required.
  const sigParsed = signatureSchema.safeParse(collectSignature(formData));
  if (!sigParsed.success) {
    return fail("Please provide a signature: type, draw, or upload one.");
  }
  const signature: ClaSignatureCapture = {
    kind: sigParsed.data.signatureKind,
    text: sigParsed.data.signatureText ?? null,
    image: sigParsed.data.signatureImage ?? null,
  };

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: {
      id: true,
      slug: true,
      claEnabled: true,
      claCorporateEnabled: true,
      claCclaCustomFields: true,
      currentCclaVersionId: true,
    },
  });
  if (!project) return fail("Project not found.");
  if (!project.claEnabled || !project.claCorporateEnabled) {
    return fail("This project does not accept Corporate CLAs.");
  }
  if (!project.currentCclaVersionId) {
    return fail("No Corporate CLA has been published for this project yet.");
  }

  // Collect + validate admin-defined CCLA custom fields.
  const customFieldDefs = parseFormSchema(project.claCclaCustomFields);
  let customFields: Record<string, string | boolean> | null = null;
  if (customFieldDefs.length > 0) {
    const raw = collectClaCustomAnswers(formData, customFieldDefs);
    const ans = buildAnswersSchema(customFieldDefs).safeParse(raw);
    if (!ans.success) {
      return fail("Please complete the required fields on the Corporate CLA form.");
    }
    customFields = ans.data as Record<string, string | boolean>;
  }

  const version = await prisma.claDocumentVersion.findUnique({
    where: { id: project.currentCclaVersionId },
    select: { version: true, contentHash: true, kind: true },
  });
  if (!version || version.kind !== "CCLA") {
    return fail("The current CLA version is unavailable. Try again shortly.");
  }

  const affirmation = buildAffirmation({
    kind: "CCLA",
    legalName: input.legalName,
    ghLogin: user.ghLogin,
    version: version.version,
    contentHash: version.contentHash,
    companyName: input.companyName,
  });

  try {
    const { corporateId, signatureId } = await recordCclaSignature({
      projectId: project.id,
      userId: user.id,
      ghId: user.ghId,
      ghLogin: user.ghLogin,
      emailSnapshot: user.email,
      legalName: input.legalName,
      affirmation,
      signature,
      customFields,
      ip,
      userAgent,
      companyName: input.companyName,
      registeredAddress: input.registeredAddress,
      country: input.country,
      contactName: input.contactName,
      signatoryTitle: input.signatoryTitle,
      contactEmail: input.contactEmail,
    });

    await recordAudit({
      projectId: project.id,
      actorId: user.id,
      kind: "cla.ccla_signed",
      payload: {
        corporateId,
        signatureId,
        companyName: input.companyName,
        ghId: user.ghId,
        ghLogin: user.ghLogin,
        documentVersion: version.version,
      },
    });

    await notifyProjectReviewers({
      projectId: project.id,
      excludeUserId: user.id,
      kind: "cla.ccla_signed",
      payload: {
        corporateId,
        companyName: input.companyName,
        signatoryGhLogin: user.ghLogin,
      },
    });
  } catch (e) {
    logger.warn({ err: e, projectId: project.id }, "ccla sign failed");
    return fail("Could not record the corporate CLA. Please try again.");
  }

  revalidatePath(`/p/${project.slug}/cla/corporate`);
  revalidatePath(`/p/${project.slug}/cla`);
  return { status: "ok" };
}

/**
 * Bulk-add roster members to a CorporateCla (self-service, performed by the
 * signatory). Refuses logins with an existing DISPUTED record (consent gate),
 * re-checks coverage for each newly covered login, and notifies reviewers.
 */
export async function addRosterMembers(
  _prev: ClaActionState,
  formData: FormData
): Promise<ClaActionState> {
  const gated = await gate();
  if (!gated.ok) return fail(gated.reason);
  const { user } = gated;

  // The bulk-import textarea is newline/comma/space separated logins, each
  // optionally @-prefixed. Normalize before schema validation.
  const rawLogins = String(formData.get("ghLogins") ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);

  const parsed = rosterAddSchema.safeParse({
    corporateId: String(formData.get("corporateId") ?? ""),
    ghLogins: rawLogins,
  });
  if (!parsed.success) {
    return fail("Enter at least one valid GitHub username (max 500).");
  }
  const input = parsed.data;

  // Authorize: the caller must be the signatory of this corporate CLA and the
  // corporate must belong to a project the contributor can see.
  const corporate = await prisma.corporateCla.findUnique({
    where: { id: input.corporateId },
    select: {
      id: true,
      projectId: true,
      status: true,
      signature: { select: { userId: true, ghId: true } },
      project: { select: { slug: true } },
    },
  });
  if (!corporate) return fail("Corporate CLA not found.");
  // The signatory may stage the roster while the CCLA is still PENDING admin
  // approval (coverage applies once it is approved). REJECTED/REVOKED are closed.
  if (corporate.status !== "ACTIVE" && corporate.status !== "PENDING") {
    return fail("This corporate CLA is no longer active.");
  }
  const isSignatory =
    corporate.signature?.userId === user.id ||
    corporate.signature?.ghId === user.ghId;
  if (!isSignatory) {
    return fail("Only the corporate CLA signatory can manage the roster.");
  }

  let added: { id: string; ghLogin: string }[] = [];
  let skippedDisputed: string[] = [];
  try {
    const result = await addRosterMembersMutation({
      corporateId: corporate.id,
      projectId: corporate.projectId,
      entries: input.ghLogins.map((ghLogin) => ({ ghLogin })),
      actorUserId: user.id,
    });
    added = result.added;
    skippedDisputed = result.skippedDisputed;

    // Re-check the newly covered contributors' CLA-gated PRs. `PrCheck` stores
    // the author's ghId alongside the (lowercased) login, so we resolve the
    // ghId from the open gated checks rather than from a User row. This works
    // even for contributors who have never signed in here, and avoids a
    // case-insensitive User lookup (unsupported on SQLite). De-dup by ghId.
    if (added.length > 0) {
      const logins = added.map((m) => m.ghLogin.toLowerCase());
      const gated = await prisma.prCheck.findMany({
        where: {
          repo: { projectId: corporate.projectId },
          authorGhLogin: { in: logins },
          status: "CHECK_REQUIRED",
        },
        select: { authorGhId: true },
        distinct: ["authorGhId"],
      });
      for (const g of gated) {
        await onClaCoverageChanged({
          projectId: corporate.projectId,
          ghId: g.authorGhId,
        });
      }
    }

    await recordAudit({
      projectId: corporate.projectId,
      actorId: user.id,
      kind: "cla.roster_added",
      payload: {
        corporateId: corporate.id,
        added: added.map((m) => m.ghLogin),
        skippedDisputed,
      },
    });

    await notifyProjectReviewers({
      projectId: corporate.projectId,
      excludeUserId: user.id,
      kind: "cla.roster_changed",
      payload: {
        corporateId: corporate.id,
        added: added.map((m) => m.ghLogin),
        skippedDisputed,
      },
    });
  } catch (e) {
    logger.warn(
      { err: e, corporateId: corporate.id },
      "roster add failed"
    );
    return fail("Could not update the roster. Please try again.");
  }

  revalidatePath(`/p/${corporate.project.slug}/cla/corporate`);
  if (skippedDisputed.length > 0) {
    return {
      status: "error",
      reason: `Added ${added.length}. Skipped (disputed, consent required): ${skippedDisputed.join(", ")}.`,
    };
  }
  return { status: "ok" };
}

/**
 * Revoke a single roster member (self-service, performed by the signatory).
 */
export async function revokeRosterMember(
  _prev: ClaActionState,
  formData: FormData
): Promise<ClaActionState> {
  const gated = await gate();
  if (!gated.ok) return fail(gated.reason);
  const { user } = gated;

  const parsed = rosterRevokeSchema.safeParse({
    corporateId: String(formData.get("corporateId") ?? ""),
    memberId: String(formData.get("memberId") ?? ""),
  });
  if (!parsed.success) return fail("Invalid request.");
  const input = parsed.data;

  const member = await prisma.cclaRosterMember.findUnique({
    where: { id: input.memberId },
    select: {
      id: true,
      corporateId: true,
      projectId: true,
      ghLogin: true,
      corporateCla: {
        select: {
          id: true,
          status: true,
          signature: { select: { userId: true, ghId: true } },
          project: { select: { slug: true } },
        },
      },
    },
  });
  if (!member || member.corporateId !== input.corporateId) {
    return fail("Roster member not found.");
  }
  const sig = member.corporateCla?.signature;
  const isSignatory = sig?.userId === user.id || sig?.ghId === user.ghId;
  if (!isSignatory) {
    return fail("Only the corporate CLA signatory can manage the roster.");
  }

  try {
    await revokeRosterMemberMutation({
      memberId: member.id,
      actorUserId: user.id,
    });

    await recordAudit({
      projectId: member.projectId,
      actorId: user.id,
      kind: "cla.roster_revoked",
      payload: {
        corporateId: member.corporateId,
        memberId: member.id,
        ghLogin: member.ghLogin,
      },
    });

    await notifyProjectReviewers({
      projectId: member.projectId,
      excludeUserId: user.id,
      kind: "cla.roster_changed",
      payload: {
        corporateId: member.corporateId,
        revoked: member.ghLogin,
      },
    });
  } catch (e) {
    logger.warn({ err: e, memberId: member.id }, "roster revoke failed");
    return fail("Could not revoke the roster member. Please try again.");
  }

  if (member.corporateCla?.project.slug) {
    revalidatePath(`/p/${member.corporateCla.project.slug}/cla/corporate`);
  }
  return { status: "ok" };
}

/**
 * Dispute a roster membership: the listed contributor asserts they are not
 * affiliated with the company. Immediately suspends coverage (status DISPUTED),
 * notifies the project reviewers + the corporate contact email, and does NOT
 * re-cover the contributor (they may now sign individually).
 */
export async function disputeMembership(
  _prev: ClaActionState,
  formData: FormData
): Promise<ClaActionState> {
  const gated = await gate();
  if (!gated.ok) return fail(gated.reason);
  const { user } = gated;

  const parsed = disputeSchema.safeParse({
    memberId: String(formData.get("memberId") ?? ""),
  });
  if (!parsed.success) return fail("Invalid request.");
  const note = formData.get("note") ? String(formData.get("note")) : undefined;

  const member = await prisma.cclaRosterMember.findUnique({
    where: { id: parsed.data.memberId },
    select: {
      id: true,
      projectId: true,
      corporateId: true,
      ghLogin: true,
      ghId: true,
      status: true,
      corporateCla: {
        select: {
          companyName: true,
          contactEmail: true,
          project: { select: { slug: true, name: true } },
        },
      },
    },
  });
  if (!member) return fail("Membership not found.");
  if (member.status === "DISPUTED") {
    return fail("This membership is already disputed.");
  }

  // The signed-in contributor must be the listed member: match ghId first,
  // then lowercased login (survives renames).
  const matches =
    (member.ghId != null && member.ghId === user.ghId) ||
    member.ghLogin.toLowerCase() === user.ghLogin.toLowerCase();
  if (!matches) {
    return fail("You can only dispute a membership listed under your account.");
  }

  try {
    await disputeRosterMembership({
      memberId: member.id,
      actorUserId: user.id,
      actorGhId: user.ghId,
      note,
    });

    await recordAudit({
      projectId: member.projectId,
      actorId: user.id,
      kind: "cla.roster_disputed",
      payload: {
        corporateId: member.corporateId,
        memberId: member.id,
        ghLogin: member.ghLogin,
        note: note ?? null,
      },
    });

    await notifyProjectReviewers({
      projectId: member.projectId,
      kind: "cla.roster_disputed",
      payload: {
        corporateId: member.corporateId,
        memberId: member.id,
        ghLogin: user.ghLogin,
        companyName: member.corporateCla?.companyName ?? null,
        note: note ?? null,
      },
    });

    // Best-effort: notify the corporate contact email. Failures are swallowed
    // by sendEmail (returns false), never block the dispute on email.
    const contactEmail = member.corporateCla?.contactEmail;
    if (contactEmail) {
      const companyName = member.corporateCla?.companyName ?? "your company";
      const projectName = member.corporateCla?.project.name ?? "a project";
      await sendEmail({
        to: contactEmail,
        subject: `CLA roster dispute for ${companyName}`,
        text:
          `GitHub user @${user.ghLogin} has disputed their membership on the ` +
          `Corporate CLA roster for ${companyName} on ${projectName}.\n\n` +
          `Their coverage has been suspended and they cannot be re-added ` +
          `until they consent.` +
          (note ? `\n\nNote: ${note}` : ""),
      });
    }
  } catch (e) {
    logger.warn({ err: e, memberId: member.id }, "roster dispute failed");
    return fail("Could not file your dispute. Please try again.");
  }

  if (member.corporateCla?.project.slug) {
    revalidatePath(`/p/${member.corporateCla.project.slug}/cla`);
    revalidatePath(`/p/${member.corporateCla.project.slug}/cla/corporate`);
  }
  return { status: "ok" };
}
