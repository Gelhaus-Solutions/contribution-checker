import { SiteHeader } from "@/components/site-header";
import { MarketingFooter } from "@/components/marketing/footer";

/**
 * Shell for the public explainer pages. A route group, so `/` stays at the
 * root and the other three sit at their own top-level paths.
 *
 * Narrower than the dashboard shell (5xl against 6xl) because these pages are
 * mostly prose and tables, and a reading measure matters more here than
 * density.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The column carries visible left and right hairlines and an opaque
    // background, so the dot grid on the page shows only in the margins. That
    // gives the content an edge to sit against instead of floating in an
    // undifferentiated field, and the sm:pl-14 is what the hanging step
    // numbers hang into.
    <div className="flex min-h-screen flex-col">
      <SiteHeader marketing width="wide" />
      <main className="mx-auto w-full max-w-[110rem] flex-1 border-x border-border bg-background px-5 sm:pr-10 sm:pl-14">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
