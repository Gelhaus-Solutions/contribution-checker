/**
 * One muted line naming who built this. No layout of its own, so a layout
 * mounts it wherever its chrome ends.
 */
export function BuiltBy() {
  return (
    <p className="px-4 py-6 text-center text-xs text-muted-foreground">
      &copy; 2026{" "}
      <a href="https://ennogelhaus.de" className="transition-colors hover:text-foreground">
        Gelhaus Solutions
      </a>
    </p>
  );
}
