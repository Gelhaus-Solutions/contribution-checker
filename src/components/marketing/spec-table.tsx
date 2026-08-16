import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";

/**
 * A reference table for the explainer pages. Real columns, hairline rules, no
 * zebra striping. Cells accept nodes so a row can carry a badge or a mono
 * identifier.
 */
export function SpecTable({
  head,
  rows,
  mono,
  className,
}: {
  head: React.ReactNode[];
  rows: React.ReactNode[][];
  /** Column indices to render in mono, e.g. status or field names. */
  mono?: number[];
  className?: string;
}) {
  const monoCols = new Set(mono ?? []);
  return (
    <TableScroll className={cn("rounded-md border border-border", className)}>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            {head.map((h, i) => (
              <TableHead key={i} className="px-3 py-2">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r} className="align-top">
              {row.map((cell, c) => (
                <TableCell
                  key={c}
                  className={cn(
                    "leading-relaxed",
                    monoCols.has(c) && "font-mono text-xs whitespace-nowrap",
                    c === 0 && "font-medium",
                  )}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  );
}
