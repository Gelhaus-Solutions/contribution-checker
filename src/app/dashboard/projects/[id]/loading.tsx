import { Skeleton } from "@/components/ui/skeleton";

/** Fallback for the project tabs. Sits inside the project shell, so the
 *  header band and sidebar stay put while the tab body loads. */
export default function ProjectTabLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-48 rounded-lg" />
      <Skeleton className="h-32 rounded-lg" />
    </div>
  );
}
