import Link from "next/link";
import { cn } from "@/lib/cn";
import { auth, signIn } from "@/auth";
import { env } from "@/lib/env";
import { unreadCount } from "@/lib/notifications/inbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { BrandMark } from "@/components/brand-mark";
import { UserCluster } from "@/components/user-cluster";
import { ThemeToggle } from "@/components/theme-toggle";

const MARKETING_LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/quality", label: "Quality" },
  { href: "/for-contributors", label: "Contributors" },
];

export async function SiteHeader({
  /** Show the marketing nav. The dashboard and admin pass nothing. */
  marketing = false,
  /** Widen the container to match a wide page shell. */
  width = "6xl",
}: {
  marketing?: boolean;
  width?: "5xl" | "6xl";
} = {}) {
  const session = await auth();
  const unread = session?.user ? await unreadCount(session.user.id) : 0;
  return (
    // Sticky with a translucent ground: on a long docs page the nav has to stay
    // reachable, and the blur keeps content legible as it scrolls underneath.
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
      <div
        className={cn(
          "mx-auto flex h-14 items-center justify-between px-4",
          width === "5xl" ? "max-w-5xl" : "max-w-6xl",
        )}
      >
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
        {marketing ? (
          <nav className="hidden items-center gap-5 text-sm md:flex">
            {MARKETING_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        ) : null}
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
