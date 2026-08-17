import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { StatusPage } from "@/components/status-page";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <StatusPage
        code="404"
        title="That page does not exist"
        description="The link may be out of date, or the project it pointed at may have been removed."
      >
        <Button asChild size="sm">
          <Link href="/how-it-works">How it works</Link>
        </Button>
      </StatusPage>
    </>
  );
}
