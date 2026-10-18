/**
 * Where to send someone after onboarding: a path on this site only, never
 * another origin (`//evil.example`, `/\evil.example`, `https://…`), so a
 * link to /welcome?next=… cannot be turned into an open redirect.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (path.length === 0 || path.length > 300) return null;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\"))
    return null;
  if (/[\u0000-\u001f\\]/u.test(path)) return null;
  return path;
}

/** The onboarding page that brings someone back to `path` once GitHub is linked. */
export function welcomeFor(path: string): string {
  return `/welcome?next=${encodeURIComponent(path)}`;
}
