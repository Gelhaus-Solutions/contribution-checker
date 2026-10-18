import "server-only";
import { prisma } from "@/lib/db";
import {
  legal,
  legalConfigured,
  type LegalEventView,
  type LegalPage,
  type LegalProjectView,
} from "@/lib/cla/legal";
import { invalidateClaProject } from "@/lib/cla/status";
import { logger } from "@/lib/logger";
import { reGateAuthorPrs, reGateProjectPrs } from "@/lib/temporal/start";

/**
 * Following a moved project's chain in GPlatform Legal (D126). Legal's admins
 * act on a project's CLAs too (D125: approve, reject or revoke a company,
 * revoke a signature, grant or revoke a waiver, mark a version for a new
 * signature), and this instance does not hear of it: its pull requests would
 * keep the check they had until they next changed. So every minute the worker
 * reads each moved project's chain past the entry it last followed, and for
 * an entry Legal's staff wrote it drops the project's cached coverage and has
 * the pull requests checked again. What this instance wrote itself it already
 * checked again when it wrote it.
 */

/** How Legal names a member of its staff where this product names its user. */
export const LEGAL_STAFF_PREFIX = "staff:";

const REASON = "cla_legal_staff";

/** Whose pull requests an entry asks to check again: one author's, all of the project's, or none. */
export type FollowStep =
  | { kind: "author"; ghId: number; ghLogin: string | null }
  | { kind: "all" }
  | null;

function payloadOf(entry: LegalEventView): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(entry.payload);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** What one chain entry asks of this instance; null for one it wrote, or one that covers nobody new. */
export function stepFor(entry: LegalEventView): FollowStep {
  if (!entry.actorUserId?.startsWith(LEGAL_STAFF_PREFIX)) return null;
  // A pending company covered nobody, so rejecting it changes nobody's check.
  if (entry.kind === "ccla.rejected") return null;
  if (
    entry.kind === "signature.revoked" ||
    entry.kind === "waiver.granted" ||
    entry.kind === "waiver.revoked"
  ) {
    const payload = payloadOf(entry);
    // A waiver may name only a login, which a pull request may spell in
    // another case: then the whole project, rather than miss the author.
    if (typeof payload.ghId === "number") {
      return {
        kind: "author",
        ghId: payload.ghId,
        ghLogin: typeof payload.ghLogin === "string" ? payload.ghLogin : null,
      };
    }
    return { kind: "all" };
  }
  // A company's roster, a version's signers, or a step this product does not
  // know yet: every pull request of the project.
  return { kind: "all" };
}

/** The entries past `followed`, oldest first, read newest first 200 at a time. */
async function entriesPast(
  projectId: string,
  followed: number,
): Promise<LegalEventView[]> {
  const fresh: LegalEventView[] = [];
  for (let page = 1; ; page += 1) {
    const answer = await legal<LegalPage<LegalEventView>>(
      "GET",
      projectId,
      `events?order=desc&perPage=200&page=${String(page)}`,
    );
    const newer = answer.items.filter((entry) => entry.seq > followed);
    fresh.push(...newer);
    if (newer.length < answer.items.length || page >= answer.pages)
      return fresh.reverse();
  }
}

/**
 * One project: its chain past the entry followed, the pull requests checked
 * again for what staff wrote, then the newest entry noted as followed. A
 * failure leaves the note where it was, so the next minute reads again.
 */
export async function followProject(project: {
  id: string;
  claLegalFollowedSeq: number | null;
}): Promise<{ entries: number; regated: number }> {
  const view = await legal<LegalProjectView>("GET", project.id, "");
  // The chain's seq starts at 0, its genesis.
  const head = view.chain.entries - 1;
  const followed = project.claLegalFollowedSeq;
  if (followed === null) {
    await prisma.project.update({
      where: { id: project.id },
      data: { claLegalFollowedSeq: head },
    });
    return { entries: 0, regated: 0 };
  }
  if (head <= followed) return { entries: 0, regated: 0 };
  const fresh = await entriesPast(project.id, followed);
  const steps = fresh
    .map(stepFor)
    .filter((step): step is NonNullable<FollowStep> => step !== null);
  let regated = 0;
  if (steps.length > 0) {
    invalidateClaProject(project.id);
    if (steps.some((step) => step.kind === "all")) {
      await reGateProjectPrs({ projectId: project.id, reason: REASON });
      regated = 1;
    } else {
      const authors = new Map<number, string | null>();
      for (const step of steps) {
        if (step.kind === "author") authors.set(step.ghId, step.ghLogin);
      }
      for (const [ghId, ghLogin] of authors) {
        await reGateAuthorPrs({
          projectId: project.id,
          ghId,
          ghLogin,
          reason: REASON,
        });
      }
      regated = authors.size;
    }
  }
  const newest = Math.max(head, ...fresh.map((entry) => entry.seq));
  await prisma.project.update({
    where: { id: project.id },
    data: { claLegalFollowedSeq: newest },
  });
  return { entries: fresh.length, regated };
}

/**
 * Every moved project, each on its own: one whose chain cannot be read is
 * logged and read again next minute. Null where Legal is not configured.
 */
export async function followClaLegalChains(): Promise<{
  projects: number;
  entries: number;
  regated: number;
} | null> {
  if (!(await legalConfigured())) return null;
  const projects = await prisma.project.findMany({
    where: { claLegalEnrolledAt: { not: null } },
    select: { id: true, claLegalFollowedSeq: true },
    orderBy: { id: "asc" },
  });
  let entries = 0;
  let regated = 0;
  for (const project of projects) {
    try {
      const done = await followProject(project);
      entries += done.entries;
      regated += done.regated;
    } catch (error) {
      logger.warn(
        { err: error, projectId: project.id },
        "cla legal follow: the project's chain could not be read",
      );
    }
  }
  return { projects: projects.length, entries, regated };
}
