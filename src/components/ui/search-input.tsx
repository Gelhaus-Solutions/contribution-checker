import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { type PageKeys } from "@/lib/pagination";

// Server component: a plain GET form. Submitting (Enter or the button) navigates
// to `?q=...`, re-rendering the server page. `hiddenParams` preserves sibling
// state (e.g. a status tab); the page key is intentionally omitted so a new
// search resets to page 1. No client JS.
export function SearchInput({
  pathname,
  q,
  placeholder,
  hiddenParams,
  keys,
}: {
  pathname: string;
  q: string;
  placeholder?: string;
  hiddenParams?: Record<string, string>;
  keys?: Partial<PageKeys>;
}) {
  const qName = keys?.q ?? "q";
  const clearHref =
    hiddenParams && Object.keys(hiddenParams).length
      ? `${pathname}?${new URLSearchParams(hiddenParams).toString()}`
      : pathname;

  return (
    <form method="GET" action={pathname} className="flex items-center gap-2">
      {hiddenParams &&
        Object.entries(hiddenParams).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      <Input
        type="search"
        name={qName}
        defaultValue={q}
        placeholder={placeholder ?? "Search"}
        className="sm:max-w-xs"
      />
      <Button type="submit" variant="outline" size="sm">
        Search
      </Button>
      {q ? (
        <Button asChild variant="ghost" size="sm">
          <Link href={clearHref}>Clear</Link>
        </Button>
      ) : null}
    </form>
  );
}
