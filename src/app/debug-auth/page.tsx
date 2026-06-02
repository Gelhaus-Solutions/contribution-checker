import { cookies } from "next/headers";
import { auth } from "@/auth";
import { env } from "@/lib/env";
import { getStackServerApp } from "@/lib/stack";
import { resolveLocalUserFromStack } from "@/lib/auth/resolve-user";
import { resolveOrgRoles } from "@/lib/auth/sync-user";

export const dynamic = "force-dynamic";

// TEMPORARY: runs in a Server Component (same context as /dashboard, unlike the
// /api/debug/whoami route handler) to see why auth() returns null here.

function jwtExp(token: string | null): number | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    const json = Buffer.from(part, "base64").toString("utf8");
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

export default async function DebugAuthPage() {
  const out: Record<string, unknown> = { context: "server-component" };

  const c = await cookies();
  const accessRaw = c.get("hexclave-access")?.value ?? null;
  out.hasAccessCookie = !!accessRaw;
  // The access cookie may wrap the JWT in JSON; try to extract it.
  let token: string | null = accessRaw;
  if (accessRaw) {
    try {
      const parsed = JSON.parse(accessRaw);
      token = parsed.accessToken ?? parsed.token ?? accessRaw;
    } catch {
      /* not JSON; use raw */
    }
  }
  const exp = jwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  out.accessTokenExp = exp;
  out.now = now;
  out.accessTokenExpired = exp != null ? exp < now : "unknown";

  let step = "getStackServerApp";
  try {
    if (!env.stackConfigured) throw new Error("stackConfigured=false");
    const app = await getStackServerApp();

    step = "getUser";
    const su = await app.getUser();
    out.getUserReturned = su ? { id: su.id, email: su.primaryEmail } : null;

    if (su) {
      step = "resolveLocalUserFromStack";
      const u = await resolveLocalUserFromStack({
        id: su.id,
        primaryEmail: su.primaryEmail,
        displayName: su.displayName,
        profileImageUrl: su.profileImageUrl,
      });
      out.localUser = { id: u.id, ghId: u.ghId, ghLogin: u.ghLogin };

      step = "resolveOrgRoles";
      out.roles = await resolveOrgRoles(su, u.ghLogin);
      step = "done";
    } else {
      step = "getUser-returned-null";
    }
  } catch (e) {
    out.failedStep = step;
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    out.stack =
      e instanceof Error ? (e.stack ?? "").split("\n").slice(0, 12) : null;
  }
  out.reachedStep = step;

  // The missing comparison: call the REAL auth() (what /dashboard uses) in this
  // same RSC context. If the steps above succeed but this is null, the deployed
  // auth() itself is broken (e.g. a stale build still has the cache() wrapper).
  try {
    const s = await auth();
    out.authResult = s?.user
      ? {
          id: s.user.id,
          ghId: s.user.ghId,
          isSuperAdmin: s.user.isSuperAdmin,
        }
      : null;
  } catch (e) {
    out.authThrew = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return (
    <pre style={{ whiteSpace: "pre-wrap", padding: 16, fontSize: 12 }}>
      {JSON.stringify(out, null, 2)}
    </pre>
  );
}
