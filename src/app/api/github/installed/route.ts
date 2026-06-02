import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * GitHub redirects here after an admin installs the App on one or more repos.
 * `state` is the projectId we want to link the repos to.
 *
 * We just bounce to a UI page that fetches the installation's repos and lets
 * the admin choose which ones to link.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    const url = new URL("/handler/sign-in", req.url);
    url.searchParams.set("after_auth_return_to", req.url);
    return NextResponse.redirect(url);
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
