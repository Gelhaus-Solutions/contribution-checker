"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_PERMISSION } from "@/lib/auth/constants";

// Each surface is gated by the leaf permission in NAV_PERMISSION (the single
// contract in constants.ts). Filtering by the viewer's effective leaf set
// reproduces today's role-rank visibility while letting an explicit extra-access
// grant reveal an individual surface.
const items: { href: string; label: string }[] = [
  { href: "", label: "Overview" },
  { href: "/applications", label: "Applications" },
  { href: "/people", label: "People" },
  { href: "/prs", label: "PRs" },
  { href: "/repos", label: "Repos" },
  { href: "/form", label: "Form" },
  { href: "/quality", label: "Quality" },
  { href: "/cla", label: "CLA" },
  { href: "/settings", label: "Settings" },
  { href: "/audit", label: "Audit log" },
];

export function ProjectNav({ id, perms }: { id: string; perms: string[] }) {
  const pathname = usePathname();
  const base = `/dashboard/projects/${id}`;
  const granted = new Set(perms);
  return (
    <nav className="flex flex-col gap-1 text-sm">
      {items
        .filter((i) => granted.has(NAV_PERMISSION[i.href]))
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
