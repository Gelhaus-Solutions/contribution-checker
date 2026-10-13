import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";
import { botStopped, presentsDecoyKey } from "@/lib/lockdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  projectSlug: z.string().min(1).max(140),
  confirmed: z
    .array(
      z.object({
        prCheckId: z.string().min(1),
        newStatus: z.enum(["APPROVED", "BYPASSED"]),
      })
    )
    .max(200),
});

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export async function POST(req: Request) {
  // GLockdown's honeytokens (src/lib/lockdown.ts): a decoy key tells GLockdown
  // at once, and is refused below exactly where an unknown token is.
  const decoy = presentsDecoyKey(req);
  // GLockdown's kill switch from AAL phase 2 (src/lib/lockdown.ts): the bot
  // stops, and no pull request is gated or touched while it holds.
  if (botStopped()) {
    return NextResponse.json({ error: "locked down" }, { status: 503 });
  }
  const token = bearerToken(req);
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { projectSlug, confirmed } = parsed.data;

  if (decoy) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }
  let claims;
  try {
    claims = await verifyGhActionsToken({
      token,
      expectedAudience: expectedAudienceForProject(projectSlug),
    });
  } catch (e) {
    if (e instanceof OidcVerificationError) {
      return NextResponse.json({ error: "invalid token" }, { status: 401 });
    }
    throw e;
  }

  const project = await prisma.project.findUnique({
    where: { slug: projectSlug },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const repo = await prisma.repo.findUnique({
    where: {
      projectId_fullName: {
        projectId: project.id,
        fullName: claims.repository,
      },
    },
    select: { id: true, installationId: true, active: true },
  });
  if (!repo || !repo.active) {
    return NextResponse.json({ error: "repo not registered" }, { status: 404 });
  }
  if (repo.installationId != null) {
    return NextResponse.json(
      { error: "repo is App-installed; CI mode disabled" },
      { status: 409 }
    );
  }

  let updated = 0;
  for (const item of confirmed) {
    const result = await prisma.prCheck.updateMany({
      where: { id: item.prCheckId, repoId: repo.id, closedByApp: true },
      data: { status: "APPROVED", closedByApp: false },
    });
    updated += result.count;
  }

  return NextResponse.json({ updated });
}
