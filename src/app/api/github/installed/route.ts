import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isRestricted, signInPath } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { presentsDecoyKey } from "@/lib/lockdown";

/**
 * GitHub redirects here after an admin installs the App on one or more repos.
 * `state` is the projectId we want to link the repos to.
 *
 * We just bounce to a UI page that fetches the installation's repos and lets
 * the admin choose which ones to link.
 */
export async function GET(req: Request) {
  // GLockdown's honeytokens (src/lib/lockdown.ts): a decoy key tells GLockdown
  // and is refused as no session, whatever the session.
  const decoy = presentsDecoyKey(req);
  const session = await auth();
  if (!session?.user || decoy) {
    const here = new URL(req.url);
    return NextResponse.redirect(
      new URL(await signInPath(here.pathname + here.search), req.url),
    );
  }
  if (isRestricted(session)) {
    return NextResponse.redirect(new URL("/restricted", req.url));
  }

  const url = new URL(req.url);
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");

  if (!installationId) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (!state) {
    return NextResponse.redirect(
      new URL(`/admin/installations/${installationId}`, req.url)
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: state },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  const target = new URL(
    `/dashboard/projects/${project.id}/repos/link`,
    req.url
  );
  target.searchParams.set("installation_id", installationId);
  return NextResponse.redirect(target);
}
