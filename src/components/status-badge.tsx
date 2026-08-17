import { Badge } from "@/components/ui/badge";
import { statusLabel, statusTone } from "@/lib/ui/status";
import { cn } from "@/lib/cn";

/**
 * Renders any status string from the database with one consistent tone and
 * label. See src/lib/ui/status.ts for why this exists.
 */
export function StatusBadge({
  status,
  /** Show the raw enum value instead of the humanised label. */
  raw = false,
  className,
}: {
  status: string;
  raw?: boolean;
  className?: string;
}) {
  return (
    <Badge variant={statusTone(status)} className={cn("shrink-0", className)}>
      {raw ? status : statusLabel(status)}
    </Badge>
  );
}
