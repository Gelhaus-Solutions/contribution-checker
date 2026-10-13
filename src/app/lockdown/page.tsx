import Link from "next/link";
import type { Metadata } from "next";
import { lockedOut } from "@/auth";
import { SiteHeader } from "@/components/site-header";
import { StatusPage } from "@/components/status-page";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { STAGE_COPY, botStopped, lockdown, signInClosed, stageStatus } from "@/lib/lockdown";

export const metadata: Metadata = {
  title: "Lockdown",
  robots: { index: false, follow: false },
};

/**
 * Where GLockdown's kill switch sends the people it refuses
 * (src/lib/lockdown.ts): `requireSession()`, every page that would otherwise
 * send them to sign in again, and the Hexclave handler once signing in is
 * closed. Public, and it reads nothing but the stage, so it answers while the
 * rest of the app is refusing.
 *
 * It says what is refused in plain words and nothing about why: never the
 * rung, the source or the time. A decoy trip raises the stage too, and whoever
 * tripped it must learn nothing from this page.
 */
export default async function LockdownPage() {
  const { stage } = lockdown();
  const copy = STAGE_COPY[stage];
  // The same memoized resolve the header already ran: no second round trip.
  const refused = await lockedOut();
  const closed = signInClosed();

  return (
    <>
      <SiteHeader />
      <StatusPage
        code="LOCKDOWN"
        title={copy.headline}
        description={
          <span className="block space-y-3">
            <span className="block">
              <StatusBadge status={stageStatus(stage)} />
            </span>
            <span className="block">{copy.explain}</span>
            {stage !== "off" ? (
              <>
                <span className="block">
                  {botStopped()
                    ? "Pull requests are not being checked either: nothing on GitHub is changed until this lifts."
                    : "Pull requests are still checked as usual, and this page and the public pages stay up."}
                </span>
                <span className="block">
                  It is a security measure taken by the people who run this instance, and it lifts
                  without anything for you to do.
                </span>
              </>
            ) : null}
          </span>
        }
      >
        {!closed ? (
          <Button asChild size="sm">
            <Link href="/handler/sign-in">Sign in</Link>
          </Button>
        ) : null}
        {refused ? (
          // Refused while still signed in to Hexclave: signing out works at
          // every stage, and the handler lets it through.
          <Button asChild size="sm" variant="outline">
            <Link href="/handler/sign-out">Sign out</Link>
          </Button>
        ) : null}
        <Button asChild size="sm" variant="outline">
          <Link href="/for-contributors">For contributors</Link>
        </Button>
      </StatusPage>
    </>
  );
}
