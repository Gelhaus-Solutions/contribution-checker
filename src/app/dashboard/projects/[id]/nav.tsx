"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { Role } from "@/lib/authz";

const items: { href: string; label: string; minRole: Role }[] = [
  { href: "", label: "Overview", minRole: "REVIEWER" },
  { href: "/applications", label: "Applications", minRole: "REVIEWER" },
  { href: "/decisions", label: "Decisions", minRole: "ADMIN" },
  { href: "/repos", label: "Repos", minRole: "ADMIN" },
  { href: "/form", label: "Form", minRole: "ADMIN" },
  { href: "/settings", label: "Settings", minRole: "ADMIN" },
  { href: "/audit", label: "Audit log", minRole: "ADMIN" },
];

const RANK = { REVIEWER: 1, ADMIN: 2, OWNER: 3 } as const;

export function ProjectNav({ id, role }: { id: string; role: Role }) {
  const pathname = usePathname();
  const base = `/dashboard/projects/${id}`;
  return (
    <nav className="flex flex-col gap-1 text-sm">
      {items
        .filter((i) => RANK[role] >= RANK[i.minRole])
        .map((i) => {
          const href = `${base}${i.href}`;
          const active =
            i.href === "" ? pathname === base : pathname.startsWith(href);
          return (
            <Link
              key={i.href}
              href={href}
              className={cn(
                "rounded-md px-3 py-1.5 transition-colors",
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
            >
              {i.label}
            </Link>
          );
        })}
    </nav>
  );
}
