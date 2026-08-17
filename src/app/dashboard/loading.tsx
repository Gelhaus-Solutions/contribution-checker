import { Skeleton } from "@/components/ui/skeleton";
import { SHELL } from "@/lib/ui/layout";

/**
 * Suspense fallback for the dashboard. Every page here is force-dynamic and
 * hits the database, so without this the browser sat on the previous route
 * with no feedback while the server worked.
 */
export default function DashboardLoading() {
  return (
    <div className={`${SHELL} py-10`}>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-2 h-4 w-72" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
