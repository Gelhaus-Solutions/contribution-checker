import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import {
  getProjectMembership,
  isRestricted,
  roleAtLeast,
  type Role,
} from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { verifyChain } from "@/lib/cla/integrity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /dashboard/projects/[id]/cla/export?format=csv|json
 *
 * Exports the project's full CLA legal record as a downloadable attachment:
 * the immutable hash-chained ledger (ClaEventLog, ordered by seq) plus the
 * operational tables (signatures, corporate CLAs, rosters, waivers) and the
 * `verifyChain` integrity result. ADMIN-only (re-checked here: server
 * components redirect, but a Route Handler returns a JSON 403 instead).
 *
 * - JSON (default): the complete record + integrity status.
 * - CSV: a single "signatures" sheet, one row per ledger entry, with the
 *   columns called out in the design.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (isRestricted(session)) {
    return NextResponse.json({ error: "restricted" }, { status: 403 });
  }

  const membership = await getProjectMembership(projectId, session.user.id);
  if (!membership || !roleAtLeast(membership.role as Role, "ADMIN")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

  // Pull the ledger (ordered by seq, the legally-authoritative ordering) plus
  // the operational tables. The ledger is the immutable record; the others are
  // current state, included so the export is self-contained.
  const [events, signatures, corporates, roster, waivers, integrity] =
    await Promise.all([
      prisma.claEventLog.findMany({
        where: { projectId },
        orderBy: { seq: "asc" },
      }),
      prisma.claSignature.findMany({
        where: { projectId },
        orderBy: { signedAt: "asc" },
      }),
      prisma.corporateCla.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.cclaRosterMember.findMany({
        where: { projectId },
        orderBy: { addedAt: "asc" },
      }),
      prisma.claWaiver.findMany({
        where: { projectId },
        orderBy: { grantedAt: "asc" },
      }),
      verifyChain(projectId),
    ]);

  await recordAudit({
    projectId,
    actorId: session.user.id,
    kind: "cla.signatures_exported",
    payload: {
      format,
      events: events.length,
      signatures: signatures.length,
      integrityOk: integrity.ok,
    },
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (format === "csv") {
    const csv = buildSignaturesCsv(events);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cla-signatures-${projectId}-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const body = JSON.stringify(
    {
      projectId,
      exportedAt: new Date().toISOString(),
      integrity,
      events,
      signatures,
      corporateClas: corporates,
      rosterMembers: roster,
      waivers,
    },
    null,
    2
  );
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="cla-export-${projectId}-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

const CSV_COLUMNS = [
  "seq",
  "signedAt",
  "kind",
  "ghLogin",
  "ghId",
  "legalName",
  "emailSnapshot",
  "companyName",
  "registeredAddress",
  "country",
  "contactName",
  "contactEmail",
  "signatoryTitle",
  "signatureKind",
  "signatureText",
  "documentVersion",
  "contentHash",
  "ip",
  "userAgent",
  "entryHash",
  "prevHash",
] as const;

/**
 * One CSV row per ledger entry, in seq order. Fields are pulled from each
 * entry's parsed payload where present (signatures carry identity/legal-name/
 * IP/UA; doc/roster/waiver entries leave those columns blank). The ledger's
 * own `seq`, `entryHash`, and `prevHash` always populate.
 */
function buildSignaturesCsv(
  events: {
    seq: number;
    kind: string;
    payload: string;
    entryHash: string;
    prevHash: string;
    createdAt: Date;
  }[]
): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];

  for (const e of events) {
    // The payload is canonical JSON written by appendClaEvent. We read it for
    // display columns only; the authoritative integrity columns (seq/hashes)
    // come straight off the row, so a malformed payload still exports cleanly.
    let p: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(e.payload);
      if (parsed && typeof parsed === "object") {
        p = parsed as Record<string, unknown>;
      }
    } catch {
      // leave display columns blank; hash columns below still populate
    }

    const signedAt =
      typeof p.signedAt === "string"
        ? p.signedAt
        : e.createdAt.toISOString();

    const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      seq: e.seq,
      signedAt,
      kind: e.kind,
      ghLogin: p.ghLogin,
      ghId: p.ghId,
      legalName: p.legalName,
      emailSnapshot: p.emailSnapshot,
      companyName: p.companyName,
      registeredAddress: p.registeredAddress,
      country: p.country,
      contactName: p.contactName,
      contactEmail: p.contactEmail,
      signatoryTitle: p.signatoryTitle,
      signatureKind: p.signatureKind,
      signatureText: p.signatureText,
      documentVersion: p.documentVersion,
      contentHash: p.contentHash,
      ip: p.ip,
      userAgent: p.userAgent,
      entryHash: e.entryHash,
      prevHash: e.prevHash,
    };

    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  }

  // Trailing newline so the file ends cleanly.
  return lines.join("\r\n") + "\r\n";
}

/** RFC-4180 cell: quote when the value contains comma/quote/newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
