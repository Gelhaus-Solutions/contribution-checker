import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";

/**
 * The centered message used by not-found and the error boundaries. Kept as one
 * component so a 404 and a 500 do not drift into looking like different
 * products.
 */
export function StatusPage({
  code,
  title,
  description,
  children,
}: {
  /** Shown in mono above the heading, e.g. "404". */
  code?: string;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <BrandMark className="size-8 text-primary" />
      {code ? (
        <p className="mt-6 font-mono text-xs tracking-widest text-muted-foreground">
          {code}
        </p>
      ) : null}
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-balance">
        {title}
      </h1>
      {description ? (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {children}
        <Button asChild variant="outline" size="sm">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
