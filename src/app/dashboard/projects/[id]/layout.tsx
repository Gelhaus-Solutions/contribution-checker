import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { getProjectPermissions, requireSession } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getProjectForViewer } from "@/lib/projects";
import { SHELL } from "@/lib/ui/layout";
import { ProjectNav } from "./nav";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const isSuperAdmin = session.user.isSuperAdmin;
  const data = await getProjectForViewer(id, session.user.id);

  // Members see their project. Super-admins can view any project even without a
  // membership row (synthesized as OWNER).
  let project: { name: string; slug: string };
  let role: string;
  if (data) {
    project = { name: data.project.name, slug: data.project.slug };
    role = data.role;
  } else if (isSuperAdmin) {
    const p = await prisma.project.findUnique({
      where: { id },
      select: { name: true, slug: true },
    });
    if (!p) notFound();
    project = p;
    role = "OWNER";
  } else {
    notFound();
  }

  const perms = await getProjectPermissions(id, session.user.id, isSuperAdmin);

  return (
    <>
      <SiteHeader />
      <div className="border-b border-border bg-muted/30">
        <div className={`${SHELL} py-4`}>
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <Link href="/dashboard" className="text-xs text-muted-foreground hover:underline">
                ← All projects
              </Link>
              <h1 className="text-xl font-semibold">{project.name}</h1>
              <p className="text-xs text-muted-foreground">
                /p/{project.slug} · role: {role}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className={`${SHELL} py-6`}>
        <div className="grid gap-6 md:grid-cols-[190px_minmax(0,1fr)]">
          <ProjectNav id={id} perms={perms} />
          <div>{children}</div>
        </div>
      </div>
    </>
  );
}
