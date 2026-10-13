import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { auth, signIn } from "@/auth";
import { env } from "@/lib/env";
import { unreadCount } from "@/lib/notifications/inbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { BrandMark } from "@/components/brand-mark";
import { UserCluster } from "@/components/user-cluster";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { STAGE_COPY, lockdown, signInClosed } from "@/lib/lockdown";

const MARKETING_LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/quality", label: "Quality" },
  { href: "/for-contributors", label: "Contributors" },
];

export async function SiteHeader({
  /** Show the marketing nav. The dashboard and admin pass nothing. */
  marketing = false,
  /** Widen the container to match a wide page shell. */
  width = "app",
}: {
  marketing?: boolean;
  width?: "app" | "wide";
} = {}) {
  const session = await auth();
  const unread = session?.user ? await unreadCount(session.user.id) : 0;
  // GLockdown's kill switch (src/lib/lockdown.ts): a file read at most once a
  // second, so every page can say when a stage is in force.
  const { stage } = lockdown();
  const gutter =
    width === "wide" ? "px-5 sm:px-8 lg:px-14" : "px-5 sm:px-8 lg:px-12";
  return (
    // Sticky with a translucent ground: on a long docs page the nav has to stay
    // reachable, and the blur keeps content legible as it scrolls underneath.
    // /90 plus a real blur, not /80 plus blur-sm: at the lighter setting the
    // text scrolling underneath stayed legible through the bar.
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/75">
      <div
        className={cn(
          "mx-auto flex h-14 w-full max-w-[110rem] items-center justify-between",
          gutter,
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
          ) : signInClosed() ? (
            // Signing in is closed to everyone: the sign-in page would only
            // send the visitor to the lockdown page, so link there directly.
            <Button asChild size="sm" variant="outline">
              <Link href="/lockdown">Sign-in paused</Link>
            </Button>
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
      {stage !== "off" ? (
        // In the sticky header on purpose: a stage in force changes what
        // every page can do, so it stays in view. The stage only, in plain
        // words: never the rung or why (see /lockdown).
        <div className="border-t border-warning/30 bg-warning/12 text-warning-strong">
          <div
            className={cn(
              "mx-auto flex w-full max-w-[110rem] flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-xs",
              gutter,
            )}
          >
            <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-medium">{STAGE_COPY[stage].headline}.</span>
            <Link href="/lockdown" className="underline underline-offset-2">
              What this means
            </Link>
            {session?.user.isSuperAdmin ? (
              <Link href="/admin/lockdown" className="underline underline-offset-2">
                GLockdown console
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
