import { prisma } from "@/lib/db";

/**
 * Short-TTL LRU-ish cache of the boolean coverage result, keyed
 * `${projectId}:${ghId}`. Mirrors the cache pattern in
 * `src/lib/github/collaborators.ts`. Invalidated by any sign/roster/waiver
 * mutation via `invalidateClaCache`.
 */
const cache = new Map<string, { value: boolean; expiresAt: number }>();
const TTL_MS = 60 * 1000;

function cacheKey(projectId: string, ghId: number): string {
  return `${projectId}:${ghId}`;
}

/**
 * Drop the cached coverage result for a contributor. Call after any mutation
 * that could change coverage (signature, roster add/revoke/dispute, waiver
 * grant/revoke, version publish with require-resign).
 */
export function invalidateClaCache(projectId: string, ghId: number): void {
  cache.delete(cacheKey(projectId, ghId));
}

export type ClaStatusResult = {
  satisfied: boolean;
  via?: "icla" | "ccla" | "waiver";
  needsResign?: boolean;
  corporate?: { id: string; companyName: string };
};

/**
 * Compute the full coverage status for a contributor on a project. Pure DB
 * reads (all indexed); not cached itself — `isClaSatisfied` caches the boolean.
 *
 * Satisfied if ANY of:
 *  - an ACTIVE ClaWaiver matching ghId or lowercased ghLogin;
 *  - an ACTIVE ICLA ClaSignature whose documentVersion >= minIclaVersion;
 *  - an ACTIVE CclaRosterMember (matched by ghId, else lowercased ghLogin)
 *    under an ACTIVE CorporateCla whose signatory signature documentVersion
 *    >= minCclaVersion.
 *
 * `needsResign` is true when an ACTIVE ICLA signature exists but its
 * documentVersion is below minIclaVersion (=> the gate reports cla_stale).
 */
export async function getClaStatus(a: {
  projectId: string;
  ghId: number;
  ghLogin: string;
}): Promise<ClaStatusResult> {
  const { projectId, ghId } = a;
  const ghLogin = a.ghLogin.toLowerCase();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { minIclaVersion: true, minCclaVersion: true },
  });
  const minIclaVersion = project?.minIclaVersion ?? 0;
  const minCclaVersion = project?.minCclaVersion ?? 0;

  // 1) Waiver — admin exemption short-circuits everything else.
  const waiver = await prisma.claWaiver.findFirst({
    where: {
      projectId,
      status: "ACTIVE",
      OR: [{ ghId }, { ghLogin }],
    },
    select: { id: true },
  });
  if (waiver) {
    return { satisfied: true, via: "waiver" };
  }

  // 2) Individual CLA — newest active signature for this ghId.
  const icla = await prisma.claSignature.findFirst({
    where: { projectId, ghId, kind: "ICLA", status: "ACTIVE" },
    orderBy: { documentVersion: "desc" },
    select: { documentVersion: true },
  });
  if (icla) {
    if (icla.documentVersion >= minIclaVersion) {
      return { satisfied: true, via: "icla" };
    }
    // A signature exists but is below the floor: stale, must re-sign.
    return { satisfied: false, via: "icla", needsResign: true };
  }

  // 3) Corporate CLA — active roster membership under an active corporate
  //    whose signatory signed a version at or above the floor.
  const member = await prisma.cclaRosterMember.findFirst({
    where: {
      projectId,
      status: "ACTIVE",
      OR: [{ ghId }, { ghLogin }],
    },
    include: { corporateCla: { include: { signature: true } } },
  });
  if (
    member &&
    member.corporateCla &&
    member.corporateCla.status === "ACTIVE" &&
    member.corporateCla.signature &&
    member.corporateCla.signature.documentVersion >= minCclaVersion
  ) {
    return {
      satisfied: true,
      via: "ccla",
      corporate: {
        id: member.corporateCla.id,
        companyName: member.corporateCla.companyName,
      },
    };
  }

  return { satisfied: false };
}

/**
 * Fast boolean coverage check used on the hot PR-decision path. Wraps
 * `getClaStatus` in a short-TTL cache keyed `${projectId}:${ghId}`.
 */
export async function isClaSatisfied(a: {
  projectId: string;
  ghId: number;
  ghLogin: string;
}): Promise<boolean> {
  const key = cacheKey(a.projectId, a.ghId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const status = await getClaStatus(a);
  cache.set(key, { value: status.satisfied, expiresAt: now + TTL_MS });
  return status.satisfied;
}
