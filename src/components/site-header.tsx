import Link from "next/link";
import { auth, signIn } from "@/auth";
import { env } from "@/lib/env";
import { unreadCount } from "@/lib/notifications/inbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { BrandMark } from "@/components/brand-mark";
import { UserCluster } from "@/components/user-cluster";
import { ThemeToggle } from "@/components/theme-toggle";

export async function SiteHeader() {
  const session = await auth();
  const unread = session?.user ? await unreadCount(session.user.id) : 0;
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link
          href="/"
          className="group flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <BrandMark className="h-7 w-7 text-primary transition-transform group-hover:rotate-3" />
          <span className="hidden sm:inline">
            <span>contribution</span>
            <span className="text-muted-foreground">/</span>
            <span>checker</span>
          </span>
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          {/* Outside the session branch on purpose: signed-out visitors and
              deployments with no Hexclave config (where UserCluster renders
              nothing) still get a theme switcher. */}
          <ThemeToggle />
          {session?.user ? (
            <>
              <Link
                href="/dashboard"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                Dashboard
              </Link>
              {/* Inbox (bell), account settings, Admin (super-admins), and sign
                  out all live in the user cluster now. */}
              <UserCluster
                isSuperAdmin={session.user.isSuperAdmin}
                unread={unread}
                stackConfigured={env.stackConfigured}
              />
            </>
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("github");
              }}
            >
              <SubmitButton size="sm">Login</SubmitButton>
            </form>
          )}
        </nav>
      </div>
    </header>
  );
}
