import { BuiltBy } from "@/components/built-by";

/**
 * Adds the attribution line under the app surfaces. The root layout no longer
 * renders it, because the marketing route group has its own full footer and
 * would otherwise show both.
 */
export default function SectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex-1">{children}</div>
      <BuiltBy />
    </div>
  );
}
