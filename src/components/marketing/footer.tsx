import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "How it works",
    links: [
      { href: "/how-it-works", label: "The gating pipeline" },
      { href: "/quality", label: "PR quality scoring" },
      { href: "/how-it-works#ci-mode", label: "GitHub Actions mode" },
    ],
  },
  {
    title: "Contributors",
    links: [
      { href: "/for-contributors", label: "My PR was closed" },
      { href: "/for-contributors#declined", label: "Appeals and cooldowns" },
      { href: "/for-contributors#sign-off", label: "DCO sign-off" },
    ],
  },
  {
    title: "Operators",
    links: [
      { href: "/admin/setup", label: "GitHub App setup" },
      { href: "/dashboard", label: "Dashboard" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto max-w-[96rem] px-5 py-12 sm:px-14">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          <div className="space-y-3">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm font-semibold tracking-tight"
            >
              <BrandMark className="size-5 text-primary" />
              <span>
                contribution
                <span className="text-muted-foreground">/</span>
                checker
              </span>
            </Link>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Self-hosted pull request gating for GitHub. Runs on your own
              infrastructure.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <p className="mb-3 text-xs font-medium">{col.title}</p>
              <ul className="space-y-2">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted-foreground">
          <p>
            &copy; 2026{" "}
            <a
              href="https://ennogelhaus.de"
              className="transition-colors hover:text-foreground"
            >
              Gelhaus Solutions
            </a>
          </p>
          <p className="font-mono">AGPL-3.0-or-later</p>
        </div>
      </div>
    </footer>
  );
}
