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
 * reads (all indexed); not cached itself. `isClaSatisfied` caches the boolean.
 *
 * Satisfied if ANY of:
 *  - an ACTIVE ClaWaiver matching ghId or lowercased ghLogin;
 *  - an ACTIVE ICLA ClaSignature on a version that is NOT resignRequired;
 *  - an ACTIVE CclaRosterMember (matched by ghId, else lowercased ghLogin)
 *    under an ACTIVE CorporateCla whose signatory signed a version that is NOT
 *    resignRequired.
 *
 * Coverage reads the per-version `ClaDocumentVersion.resignRequired` flag, not
 * the old monotonic floor: a contributor may hold an older still-valid signature
 * alongside a newer stale one, so we test for the EXISTENCE of any active
 * signature on a non-stale version rather than only inspecting the newest.
 *
 * `needsResign` is true when an ACTIVE ICLA signature exists but every one of
 * them is on a resignRequired version (=> the gate reports cla_stale).
 */
export async function getClaStatus(a: {
  projectId: string;
  ghId: number;
  ghLogin: string;
}): Promise<ClaStatusResult> {
  const { projectId, ghId } = a;
  const ghLogin = a.ghLogin.toLowerCase();

  // 1) Waiver: admin exemption short-circuits everything else.
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

  // 2) Individual CLA: any ACTIVE signature on a non-stale (resignRequired=false)
  //    version covers. If one exists, covered. If none does but the contributor
  //    has at least one ACTIVE ICLA signature, every signature is stale -> they
  //    must re-sign.
  const validIcla = await prisma.claSignature.findFirst({
    where: {
      projectId,
      ghId,
      kind: "ICLA",
      status: "ACTIVE",
      version: { is: { resignRequired: false } },
    },
    select: { id: true },
  });
  if (validIcla) {
    return { satisfied: true, via: "icla" };
  }
  const anyIcla = await prisma.claSignature.findFirst({
    where: { projectId, ghId, kind: "ICLA", status: "ACTIVE" },
    select: { id: true },
  });
  if (anyIcla) {
    // Signatures exist but all are on resignRequired versions: must re-sign.
    return { satisfied: false, via: "icla", needsResign: true };
  }

  // 3) Corporate CLA: active roster membership under an active corporate whose
  //    signatory signed a non-stale version. A contributor may be on several
  //    rosters (multiple CCLAs, some PENDING/REJECTED/REVOKED), so the relation
  //    filter keeps only memberships under an ACTIVE corporate and we pick the
  //    first whose signatory signature is on a resignRequired=false version.
  //    Without this filter a findFirst could land on a non-active corporate and
  //    wrongly report not-covered even when another active corporate covers the
  //    same person.
  const members = await prisma.cclaRosterMember.findMany({
    where: {
      projectId,
      status: "ACTIVE",
      OR: [{ ghId }, { ghLogin }],
      corporateCla: { is: { status: "ACTIVE" } },
    },
    include: {
      corporateCla: {
        include: { signature: { include: { version: { select: { resignRequired: true } } } } },
      },
    },
  });
  const covering = members.find(
    (m) =>
      m.corporateCla?.status === "ACTIVE" &&
      m.corporateCla.signature != null &&
      m.corporateCla.signature.version?.resignRequired === false
  );
  if (covering && covering.corporateCla) {
    return {
      satisfied: true,
      via: "ccla",
      corporate: {
        id: covering.corporateCla.id,
        companyName: covering.corporateCla.companyName,
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
