import "server-only";
import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { fetchGithubUserById, recordSignInMetric, seededRoles } from "@/lib/auth/sync-user";
import { pushAccount } from "@/lib/gpterms";

/** The GitHub account on a person's GPID link: the numeric id and the login as of their last sign-in. */
export type GithubLink = { ghId: number; ghLogin: string | null };

/** What GPID's introspection says about the person behind a session, narrowed to what is read here. */
export type GpidPerson = {
  /** Pairwise and stable for this app; `User.ssoSubject`. */
  subject: string;
  /** GPID's verified address, or null. */
  email: string | null;
  displayName: string | null;
  github: GithubLink | null;
};

/**
 * The GitHub link out of an introspection answer's `links` (told to a native
 * product only), or null when there is none or its id is not GitHub's numeric
 * kind.
 */
export function githubLinkOf(answer: {
  links?: { provider: string; accountId: string; login: string | null }[];
}): GithubLink | null {
  const link = answer.links?.find((l) => l.provider === "github");
  if (!link) return null;
  const ghId = Number(link.accountId);
  if (!Number.isSafeInteger(ghId) || ghId <= 0) return null;
  return { ghId, ghLogin: link.login?.trim() || null };
}

/** Refused rather than resolved: binding this session would hand somebody else's account over. */
export class AccountConflict extends Error {}

/**
 * Resolve a GPID session to its local `User` row, establishing "a GPID session
 * implies exactly one local User row", so every downstream `session.user.id`
 * is a valid local FK target.
 *
 *   1. By `ssoSubject` (the normal case once linked, or backfilled from the
 *      Hexclave import's subject map).
 *   2. By GitHub id, for a row from before the move that the backfill did not
 *      reach. GitHub's numeric id is what every row here is keyed on.
 *   3. By address, for a row with no GitHub id of its own (or the same one).
 *   4. Otherwise a new row, with the GitHub identity from the link and the org
 *      roles SUPER_ADMINS and PROJECT_CREATORS seed.
 *
 * A row already bound to a different subject is never taken over: that is
 * `AccountConflict`, and auth() treats the session as signed out.
 */
export async function resolveLocalUser(person: GpidPerson): Promise<User> {
  const bySubject = await prisma.user.findUnique({ where: { ssoSubject: person.subject } });
  if (bySubject) return refreshGithub(bySubject, person.github);

  if (person.github) {
    const byGithub = await prisma.user.findUnique({ where: { ghId: person.github.ghId } });
    if (byGithub) {
      if (byGithub.ssoSubject !== null) {
        throw new AccountConflict(
          `GitHub account ${person.github.ghId} is bound to another GPID subject here`,
        );
      }
      return bindSubject(byGithub, person);
    }
  }

  const email = person.email?.trim() || null;
  if (email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (
      byEmail &&
      byEmail.ssoSubject === null &&
      (byEmail.ghId === null || byEmail.ghId === person.github?.ghId)
    ) {
      return bindSubject(byEmail, person);
    }
  }

  return createUser(person, email);
}

/** Bind a pre-existing row to the subject, filling its GitHub identity where it has none. */
async function bindSubject(user: User, person: GpidPerson): Promise<User> {
  try {
    const linked = await prisma.user.update({
      where: { id: user.id },
      data: { ssoSubject: person.subject, ...githubFields(user, person.github) },
    });
    recordSignInMetric(false);
    return linked;
  } catch (e) {
    // A concurrent request may have linked it first; re-read by subject.
    logger.warn({ err: e, "auth.user_id": user.id }, "auth: race binding a local user to its GPID subject");
    const linked = await prisma.user.findUnique({ where: { ssoSubject: person.subject } });
    if (linked) return linked;
    throw e;
  }
}

/**
 * Keep the login current: GitHub lets people rename, and GPID takes the login
 * again at every sign-in. The id is never rewritten once set, because
 * applications and decisions hang off it; a different GitHub account on the
 * same GPID account is logged rather than followed.
 */
async function refreshGithub(user: User, github: GithubLink | null): Promise<User> {
  if (!github) return user;
  if (user.ghId !== null && user.ghId !== github.ghId) {
    logger.warn(
      { "auth.user_id": user.id, "github.id": github.ghId },
      "auth: GPID names a different GitHub account than this row's; keeping the row's",
    );
    return user;
  }
  const data = githubFields(user, github);
  if (Object.keys(data).length === 0) return user;
  try {
    return await prisma.user.update({ where: { id: user.id }, data });
  } catch (e) {
    // The login is unique here; another row holding it (a stale rename) must
    // not stop this person signing in.
    logger.warn({ err: e, "auth.user_id": user.id }, "auth: refreshing the GitHub login failed");
    return user;
  }
}

/** The GitHub columns that differ from the link. */
function githubFields(user: User, github: GithubLink | null): Prisma.UserUpdateInput {
  if (!github) return {};
  const data: Prisma.UserUpdateInput = {};
  if (user.ghId === null) data.ghId = github.ghId;
  if (github.ghLogin && user.ghLogin !== github.ghLogin) data.ghLogin = github.ghLogin;
  return data;
}

/** A new row, named and pictured from GitHub's public profile where it answers. */
async function createUser(person: GpidPerson, email: string | null): Promise<User> {
  let name = person.displayName;
  let image: string | null = null;
  if (person.github) {
    try {
      const gh = await fetchGithubUserById(person.github.ghId);
      name = gh.name ?? name;
      image = gh.avatar_url;
    } catch (e) {
      logger.warn(
        { err: e, "github.id": person.github.ghId },
        "auth: could not fetch the GitHub profile for a new account",
      );
    }
  }
  // Only set the address and the login if they are free, so a second account
  // cannot collide on either unique column.
  const emailIsFree = !!email && !(await prisma.user.findUnique({ where: { email } }));
  const login = person.github?.ghLogin ?? null;
  const loginIsFree = !!login && !(await prisma.user.findUnique({ where: { ghLogin: login } }));
  const roles = seededRoles(loginIsFree ? login : null);
  try {
    const created = await prisma.user.create({
      data: {
        ssoSubject: person.subject,
        email: emailIsFree ? email : null,
        name,
        image,
        ghId: person.github?.ghId ?? null,
        ghLogin: loginIsFree ? login : null,
        isSuperAdmin: roles.isSuperAdmin,
        canCreateProj: roles.canCreateProj,
      },
    });
    recordSignInMetric(true);
    // Terms is told about every account from its first day, so its notices
    // reach it; the push waits in the outbox when the service is away.
    await pushAccount(created);
    return created;
  } catch (e) {
    // Unique race on ssoSubject: another request created it first.
    const existing = await prisma.user.findUnique({ where: { ssoSubject: person.subject } });
    if (existing) return existing;
    throw e;
  }
}
