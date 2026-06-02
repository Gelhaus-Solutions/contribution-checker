import Link from "next/link";
import Image from "next/image";
import { auth, signIn, signOut } from "@/auth";
import { unreadCount } from "@/lib/notifications/inbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { BrandMark } from "@/components/brand-mark";

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
          {session?.user ? (
            <>
              <Link href="/dashboard" className="hover:underline">
                Dashboard
              </Link>
              <Link
                href="/dashboard/notifications"
                className="relative hover:underline"
                aria-label="Notifications"
              >
                Inbox
                {unread > 0 && (
                  <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
                    {unread}
                  </span>
                )}
              </Link>
              {session.user.isSuperAdmin && (
                <Link href="/admin" className="hover:underline">
                  Admin
                </Link>
              )}
              <div className="flex items-center gap-2">
                {session.user.image && (
                  <Image
                    src={session.user.image}
                    alt={session.user.ghLogin ?? ""}
                    width={24}
                    height={24}
                    className="rounded-full"
                  />
                )}
                <span className="text-muted-foreground">
                  {session.user.ghLogin ?? session.user.name}
                </span>
              </div>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <SubmitButton variant="ghost" size="sm">
                  Sign out
                </SubmitButton>
              </form>
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
