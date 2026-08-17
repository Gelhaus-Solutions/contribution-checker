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
    <div className="flex min-h-screen flex-col">
      <SiteHeader marketing width="5xl" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4">{children}</main>
      <MarketingFooter />
    </div>
  );
}
