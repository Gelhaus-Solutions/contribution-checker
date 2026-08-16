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

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Right-aligns and applies tabular numerals. Use for counts and scores. */
  align?: "left" | "right";
  /** Hide the column below this breakpoint, so wide tables survive mobile. */
  hideBelow?: "sm" | "md" | "lg";
  /** A width hint, e.g. "8rem". */
  width?: string;
  className?: string;
};

const HIDE = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

/**
 * Column-configured table for the genuinely tabular views: PRs, people, audit,
 * CLA signatures, and the admin allowlist.
 *
 * Rich rows whose internal layout varies should use ui/list instead. A column
 * config only pays for itself when the columns actually line up.
 *
 * Deliberately has no "use client": it renders fine from a server component as
 * long as no onRowClick is passed. The two client callers already carry their
 * own directive.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty,
  footer,
  className,
}: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className={className}>
      <TableScroll>
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead
                  key={c.key}
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    c.align === "right" && "text-right",
                    c.hideBelow && HIDE[c.hideBelow],
                    c.className,
                  )}
                >
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                data-interactive={onRowClick ? "" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={cn(
                      c.align === "right" && "text-right tabular-nums",
                      c.hideBelow && HIDE[c.hideBelow],
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      {footer}
    </div>
  );
}
