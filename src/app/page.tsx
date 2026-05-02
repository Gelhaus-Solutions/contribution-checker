import Link from "next/link";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";

export default async function Home() {
  const session = await auth();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-20">
        <h1 className="text-4xl font-bold tracking-tight">
          Gate your PRs behind an application.
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Open-source maintainers: stop manually triaging unsolicited PRs. Wire up
          a GitHub App, and contribution-checker will auto-close PRs from
          contributors who haven&apos;t applied — and reopen them once you approve.
        </p>
        <div className="mt-8 flex gap-3">
          {session?.user ? (
            <Button asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href="/api/auth/signin">Sign in with GitHub</Link>
            </Button>
          )}
        </div>
      </main>
    </>
  );
}
