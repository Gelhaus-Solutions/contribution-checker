import "server-only";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

/**
 * A GitHub account's PUBLIC profile by numeric id. `GET /user/{id}` resolves
 * login, name and avatar for any account with no auth, so nothing here needs a
 * GitHub token of the person's. GPID already hands over the numeric id and the
 * login on its link; this adds the name and the picture, best effort.
 *
 * A server token (GITHUB_TOKEN) is attached when present only to lift the 60/hr
 * unauthenticated rate limit; it is not required.
 */
export async function fetchGithubUserById(id: number): Promise<GithubUser> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "contribution-checker",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/user/${id}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub /user/${id} fetch failed: ${res.status}`);
  }
  return (await res.json()) as GithubUser;
}

/**
 * The GitHub login of a user whose row has the GitHub id but not the login:
 * an account from before GPID kept logins, or one whose login was taken by
 * another row when it was written. Resolved by id now and kept; null when
 * GitHub still does not answer, or the login is another row's.
 */
export async function fillGithubLogin(
  userId: string,
  ghId: number,
): Promise<string | null> {
  try {
    const gh = await fetchGithubUserById(ghId);
    if (!gh.login) return null;
    await prisma.user.update({
      where: { id: userId },
      data: { ghLogin: gh.login },
    });
    return gh.login;
  } catch (e) {
    logger.warn(
      { err: e, "auth.user_id": userId, "github.id": ghId },
      "auth: filling a missing GitHub login failed",
    );
    return null;
  }
}

export type OrgRoles = { isSuperAdmin: boolean; canCreateProj: boolean };

/**
 * The org roles a GitHub login starts with: SUPER_ADMINS makes a super-admin,
 * PROJECT_CREATORS a project creator. Applied once, when an account first
 * gets that login, never again: the columns on `User` are the truth since the
 * move off Hexclave, and /admin/allowlist changes them, so a revocation there
 * must not be undone by the environment at the next sign-in.
 */
export function seededRoles(ghLogin: string | null): OrgRoles {
  const login = ghLogin?.toLowerCase() ?? null;
  const isSuperAdmin = login !== null && env.superAdmins.includes(login);
  return {
    isSuperAdmin,
    canCreateProj: isSuperAdmin || (login !== null && env.projectCreators.includes(login)),
  };
}

/** Emit the auth.signin metric (preserved from the old NextAuth signIn event). */
export function recordSignInMetric(isNewUser: boolean): void {
  Sentry.metrics.count("auth.signin", 1, {
    attributes: { provider: "gpid", "auth.is_new_user": isNewUser },
  });
}

/** Emit the auth.signout metric, from the sign-out route and the signOut() shim. */
export function recordSignOutMetric(): void {
  Sentry.metrics.count("auth.signout", 1, {
    attributes: { provider: "gpid" },
  });
}
