import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";

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
