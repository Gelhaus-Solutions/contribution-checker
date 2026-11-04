import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSso, SESSION_COOKIE } from "@/lib/sso";
import { AccountConflict, githubLinkOf, resolveLocalUser } from "@/lib/auth/resolve-user";
import { recordSignOutMetric } from "@/lib/auth/sync-user";
import { setSentryUser } from "@/lib/observability/sentry-user";
import type { Session, SessionUser } from "@/lib/auth-types";
import { standingOf } from "@/lib/gpterms";
import { isDecoyLogin, lockdown } from "@/lib/lockdown";

export type { Session } from "@/lib/auth-types";

/**
 * Drop-in replacement for the old NextAuth `auth()`.
 *
 * Reads the GPID session token from its cookie (src/lib/sso.ts), asks GPID who
 * is behind it, resolves that to the local `User` row, and returns the SAME
 * `{ user: {...} }` shape the rest of the app already consumes. Returns null
 * when there is no session or GPID is not configured (keeps build/test and
 * unconfigured deploys safe).
 *
 * GPID's answer is cached for the window it states (`revalidateWithin`) and no
 * longer, by the SDK, so a lockdown or a revocation there lands here inside
 * that window. Org roles (isSuperAdmin/canCreateProj) are this app's own
 * columns since the move off Hexclave, managed in /admin/allowlist.
 *
 * Memoized per request with React `cache()`, because auth() is called several
 * times on a single page (root layout, SiteHeader, requireSession, then again
 * by requireProjectRole in the page). `cookies()` inside a `cache()` scope is
 * fine: Next only rejects it under `"use cache"` / `unstable_cache(...)`. If a
 * runtime ever does refuse the memo, the wrapper below falls back to resolving
 * directly rather than reporting the request as signed out.
 *
 * Besides the session it says whether GLockdown's kill switch is why there is
 * none (`lockedOut`), so `requireSession()` can send that person to /lockdown
 * rather than to a sign-in that would only refuse them again.
 */
interface Resolved {
  session: Session | null;
  lockedOut: boolean;
}

const SIGNED_OUT: Resolved = { session: null, lockedOut: false };
const LOCKED_OUT: Resolved = { session: null, lockedOut: true };

async function resolveSession(): Promise<Resolved> {
  if (!env.gpidConfigured) return SIGNED_OUT;
  // GLockdown's kill switch (src/lib/lockdown.ts): at `full`, and from AAL
  // phase 1 whatever the stage, nobody is signed in, existing sessions
  // included.
  const { stage, refusesEveryCredential } = lockdown();
  if (stage === "full" || refusesEveryCredential) {
    setSentryUser(null);
    return LOCKED_OUT;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    setSentryUser(null);
    return SIGNED_OUT;
  }
  try {
    const answer = await (await getSso()).resolve(token);
    // A person only: a machine or an integration has no business with this
    // app's screens, whatever token it presents in a cookie.
    if (!answer.active || !answer.subject || (answer.principal ?? "person") !== "person") {
      setSentryUser(null);
      return SIGNED_OUT;
    }
    const subject = answer.subject;
    const email = answer.email ?? null;
    // GLockdown's honeytokens (L97): a session as the decoy admin is refused
    // before anything is looked up, linked or created for it, exactly as no
    // session at all, and GLockdown is told. Nobody signs in as the decoy.
    if (isDecoyLogin(email, `GPID subject ${subject}`)) {
      setSentryUser(null);
      return SIGNED_OUT;
    }
    const github = githubLinkOf(answer);
    // From `signups` no new account: an account this app has not seen yet is
    // not created, and the person is not signed in.
    if (stage !== "off" && !(await knownAccount(subject, github?.ghId ?? null, email))) {
      setSentryUser(null);
      return LOCKED_OUT;
    }

    const u = await resolveLocalUser({
      subject,
      email,
      displayName: answer.displayName ?? null,
      github,
    });
    // The decoy's GitHub login too. An intruder who registered that login on
    // GitHub presents it here.
    if (isDecoyLogin(u.ghLogin, `GPID subject ${subject}`)) {
      setSentryUser(null);
      return SIGNED_OUT;
    }

    const roles = { isSuperAdmin: u.isSuperAdmin, canCreateProj: u.isSuperAdmin || u.canCreateProj };
    const terms = await termsOf(u);

    // `admins`: only super-admins. `members`: super-admins and project members.
    if (stage === "admins" && !roles.isSuperAdmin) {
      setSentryUser(null);
      return LOCKED_OUT;
    }
    if (
      stage === "members" &&
      !roles.isSuperAdmin &&
      (await prisma.projectMember.count({ where: { userId: u.id } })) === 0
    ) {
      setSentryUser(null);
      return LOCKED_OUT;
    }

    setSentryUser({ id: u.id, ghLogin: u.ghLogin, email: u.email });

    return {
      lockedOut: false,
      session: {
        user: {
          id: u.id,
          name: u.name,
          email: u.email ?? "",
          image: u.image,
          ghId: u.ghId,
          ghLogin: u.ghLogin,
          country: null,
          isSuperAdmin: roles.isSuperAdmin,
          canCreateProj: roles.canCreateProj,
          // GPID only ever names a verified address. It counts for the row's
          // own address, which is what the app shows and reports.
          emailVerified:
            email !== null &&
            !!u.email &&
            u.email.trim().toLowerCase() === email.trim().toLowerCase(),
          terms,
        },
      },
    };
  } catch (e) {
    if (e instanceof AccountConflict) logger.warn({ err: e }, "auth: refused a session bound elsewhere");
    else logger.error({ err: e }, "auth: failed to resolve session");
    setSentryUser(null);
    return SIGNED_OUT;
  }
}

/**
 * Whether this app has an account for the person already: by GPID subject, by
 * GitHub id, or by address, what `resolveLocalUser` would bind instead of
 * creating.
 */
async function knownAccount(subject: string, ghId: number | null, email: string | null): Promise<boolean> {
  const bySubject = await prisma.user.findUnique({ where: { ssoSubject: subject }, select: { id: true } });
  if (bySubject) return true;
  if (ghId !== null && (await prisma.user.findUnique({ where: { ghId }, select: { id: true } }))) return true;
  const address = email?.trim();
  if (!address) return false;
  return !!(await prisma.user.findUnique({ where: { email: address }, select: { id: true } }));
}

/**
 * Where an account stands with the terms: asked of GPlatform Terms where it is
 * used, weighed against every acceptance recorded here (src/lib/gpterms.ts).
 * Undefined when the step is off, and when the read fails: the standing gates
 * writes, and a failed read must not stop a signed-in person from reading.
 */
async function termsOf(u: { id: string; createdAt: Date }): Promise<SessionUser["terms"]> {
  if (env.termsAcceptStep !== "on") return undefined;
  try {
    const standing = await standingOf(u);
    return {
      kind: standing.kind,
      inForceFrom: standing.inForceFrom?.toISOString() ?? null,
      record: standing.record,
    };
  } catch (e) {
    logger.warn({ err: e, "auth.user_id": u.id }, "auth: reading the terms standing failed");
    return undefined;
  }
}

const memoizedSession = cache(resolveSession);

async function resolved(): Promise<Resolved> {
  try {
    return await memoizedSession();
  } catch (e) {
    // resolveSession swallows its own failures, so reaching here means the
    // memo itself refused (no cache scope available in this runtime). Resolve
    // uncached rather than returning null: a null here reads as "signed out"
    // and would bounce every signed-in user to the sign-in.
    logger.warn({ err: e }, "auth: session memo unavailable, resolving direct");
    return resolveSession();
  }
}

export async function auth(): Promise<Session | null> {
  return (await resolved()).session;
}

/**
 * Whether GLockdown's kill switch is why this request has no session: a
 * signed-in person the stage refuses, or everyone at `full`. Read from the same
 * memoized resolve as `auth()`, so it costs nothing after it.
 */
export async function lockedOut(): Promise<boolean> {
  return (await resolved()).lockedOut;
}

/**
 * Sign-in shim. The `provider` argument is accepted for call-site
 * compatibility and ignored: GitHub through GPID is the only way in.
 * `/auth/github` starts the flow and keeps the post-auth return path the
 * apply and CLA flows use.
 */
export async function signIn(
  _provider?: string,
  opts?: { redirectTo?: string },
): Promise<void> {
  redirect(signInUrl(opts?.redirectTo));
}

/** Where a sign-in starts, bringing the person back to `returnTo` (a path here) afterwards. */
export function signInUrl(returnTo?: string): string {
  return returnTo ? `/auth/github?returnTo=${encodeURIComponent(returnTo)}` : "/auth/github";
}

/**
 * Sign out of this app: the cookie goes and the SDK forgets its cached answer
 * for the token, so nothing here believes it a moment longer. The GPID session
 * itself is GPID's to end; this app is one of the places it reaches.
 */
export async function signOut(opts?: { redirectTo?: string }): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  jar.delete(SESSION_COOKIE);
  if (token && env.gpidConfigured) {
    try {
      (await getSso()).forget(token);
    } catch (e) {
      logger.warn({ err: e }, "auth: forgetting the session token failed");
    }
  }
  recordSignOutMetric();
  setSentryUser(null);
  redirect(opts?.redirectTo ?? "/");
}
