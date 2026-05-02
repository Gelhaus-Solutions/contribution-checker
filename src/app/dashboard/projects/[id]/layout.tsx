import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { requireSession } from "@/lib/authz";
import { getProjectForViewer } from "@/lib/projects";
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
  const data = await getProjectForViewer(id, session.user.id);
  if (!data) notFound();

  return (
    <>
      <SiteHeader />
      <div className="border-b border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-4 py-4">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <Link href="/dashboard" className="text-xs text-muted-foreground hover:underline">
                ← All projects
              </Link>
              <h1 className="text-xl font-semibold">{data.project.name}</h1>
              <p className="text-xs text-muted-foreground">
                /p/{data.project.slug} · role: {data.role}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid gap-6 md:grid-cols-[180px_1fr]">
          <ProjectNav id={id} role={data.role} />
          <div>{children}</div>
        </div>
      </div>
    </>
  );
}
