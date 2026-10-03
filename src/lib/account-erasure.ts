import "server-only";
import type { Prisma } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { closeAccount } from "@/lib/gpterms";
import { logger } from "@/lib/logger";
import { getSecret } from "@/lib/vault/resolver";

/**
 * Erasure on request (GDPR Art. 17, and Art. 21 after an objection): one
 * person's data, by category, with a report of what went and what stayed.
 *
 * A request names categories rather than meaning "everything", because an
 * objection is to some processing and the answer is per purpose: a project may
 * still need to know that a login it refused is refused. Two things are never
 * erased here: a CLA signature, which is evidence of a licence grant and is
 * revoked rather than erased (the project decides), and a project's manual
 * decision about a login, which is the project's own record.
 *
 * **A denial is kept only while it still binds.** With `keepDenialRecords`, an
 * application being erased that was denied without re-application, or whose
 * cooldown is still running, leaves a manual DENIED decision for its login, so
 * the gate keeps refusing it. Nothing else of the application stays: no
 * answers, no reason, no reviewer. A denial that no longer binds (re-applying
 * is allowed) leaves nothing, because the gate would not use it and keeping it
 * would make the person's position worse than it was.
 *
 * Dry run by default. `execute` writes in one transaction, then deletes the
 * Hexclave identities and tells GPlatform Terms the account is closed. The
 * audit entry it leaves names the request reference, the categories and the
 * counts, never the person.
 */

export const ERASURE_CATEGORIES = {
  account:
    "The account (name, email address, image, GitHub link), its notifications, project memberships and terms acceptances, and its sign-in identity in Hexclave. Implies applications.",
  applications: "Applications to contribute: answers, decision, reason, notes, reviews and appeals.",
  prChecks: "Pull request checks and their quality results.",
  aiResults: "AI results about their applications and pull requests.",
  auditEvents: "Audit entries naming them, their applications or their pull request checks.",
} as const;

export type ErasureCategory = keyof typeof ERASURE_CATEGORIES;

export const NEVER_ERASED = [
  {
    what: "CLA signatures",
    why: "Evidence of a licence grant: revoked rather than erased, and erasing one is the project's decision.",
  },
  {
    what: "Manual decisions about the login",
    why: "A project's own decision; the project removes it.",
  },
] as const;

export interface ErasureSubject {
  ghLogin?: string | null;
  email?: string | null;
}

export interface ErasureOptions {
  categories: readonly ErasureCategory[];
  keepDenialRecords: boolean;
  /** Your reference for the request, written to the audit entry. Never personal data. */
  requestRef: string;
  execute: boolean;
  now?: Date;
}

export interface DenialRecord {
  projectId: string;
  ghLogin: string;
  ghId: number | null;
  reason: string;
}

export interface ErasureReport {
  requestRef: string;
  executed: boolean;
  categories: ErasureCategory[];
  found: {
    users: number;
    applications: number;
    prChecks: number;
    signatures: number;
    manualDecisions: number;
  };
  erased: Record<string, number>;
  denialRecords: DenialRecord[];
  hexclaveIdentities: number;
  kept: { what: string; why: string }[];
}

/** `account` cascades to applications in the database, so it is never alone. */
export function normaliseCategories(requested: readonly string[]): ErasureCategory[] {
  const known = new Set(Object.keys(ERASURE_CATEGORIES));
  const unknown = requested.filter((c) => !known.has(c));
  if (unknown.length > 0) throw new Error(`unknown erasure categories: ${unknown.join(", ")}`);
  const set = new Set(requested as ErasureCategory[]);
  if (set.has("account")) set.add("applications");
  return (Object.keys(ERASURE_CATEGORIES) as ErasureCategory[]).filter((c) => set.has(c));
}

/**
 * Whether a denied application still keeps its applicant out, and the reason a
 * kept record carries. Null when it does not bind any more.
 */
export function denialStillBinds(
  app: { status: string; allowResubmit: boolean; cooldownUntil: Date | null; decidedAt: Date | null },
  requestRef: string,
  now: Date,
): string | null {
  if (app.status !== "DENIED") return null;
  const decided = app.decidedAt ? ` on ${app.decidedAt.toISOString().slice(0, 10)}` : "";
  const origin = `Application denied${decided}; the application was erased on request ${requestRef} and this is the gate's only record of the denial.`;
  if (!app.allowResubmit) return `${origin} Re-applying was not allowed.`;
  if (app.cooldownUntil && app.cooldownUntil > now) {
    return `${origin} Re-applying is allowed from ${app.cooldownUntil.toISOString().slice(0, 10)}: remove this decision then.`;
  }
  return null;
}

export async function eraseSubject(
  subject: ErasureSubject,
  options: ErasureOptions,
): Promise<ErasureReport> {
  const now = options.now ?? new Date();
  const categories = normaliseCategories(options.categories);
  const has = (c: ErasureCategory) => categories.includes(c);
  const login = subject.ghLogin?.trim().toLowerCase() || null;
  const email = subject.email?.trim().toLowerCase() || null;
  if (!login && !email) throw new Error("an erasure needs a GitHub login or an email address");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(options.requestRef)) {
    throw new Error("requestRef must be a short reference without personal data");
  }

  const users = await prisma.user.findMany({
    where: {
      OR: [
        ...(login ? [{ ghLogin: { equals: login, mode: "insensitive" as const } }] : []),
        ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
      ],
    },
    select: { id: true, email: true, ghLogin: true, ghId: true, stackUserId: true },
  });
  const userIds = users.map((u) => u.id);
  const logins = [...new Set([login, ...users.map((u) => u.ghLogin?.toLowerCase())].filter(Boolean))] as string[];
  const ghIds = [...new Set(users.map((u) => u.ghId).filter((v): v is number => typeof v === "number"))];

  const applications = await prisma.application.findMany({
    where: { userId: { in: userIds } },
    select: {
      id: true,
      projectId: true,
      status: true,
      allowResubmit: true,
      cooldownUntil: true,
      decidedAt: true,
    },
  });
  const appIds = applications.map((a) => a.id);

  const prChecks = await prisma.prCheck.findMany({
    where: {
      OR: [
        ...logins.map((l) => ({ authorGhLogin: { equals: l, mode: "insensitive" as const } })),
        ...(ghIds.length > 0 ? [{ authorGhId: { in: ghIds } }] : []),
      ],
    },
    select: { id: true },
  });
  const prCheckIds = prChecks.map((p) => p.id);

  const [signatures, manualDecisions] = await Promise.all([
    prisma.claSignature.count({ where: { OR: logins.map((l) => ({ ghLogin: { equals: l, mode: "insensitive" as const } })) } }),
    prisma.manualDecision.count({ where: { ghLogin: { in: logins } } }),
  ]);

  const denialRecords: DenialRecord[] =
    options.keepDenialRecords && has("applications")
      ? applications.flatMap((app) => {
          const reason = denialStillBinds(app, options.requestRef, now);
          const ghLogin = logins[0];
          return reason && ghLogin ? [{ projectId: app.projectId, ghLogin, ghId: ghIds[0] ?? null, reason }] : [];
        })
      : [];

  const aiKeys = [...appIds.map((id) => `application:${id}`), ...prCheckIds.map((id) => `prcheck:${id}`)];
  const mentions = [...userIds, ...appIds, ...prCheckIds, ...logins];
  const auditWhere: Prisma.AuditEventWhereInput = {
    OR: [
      ...(userIds.length > 0 ? [{ actorId: { in: userIds } }] : []),
      ...mentions.map((m) => ({ payload: { contains: m, mode: "insensitive" as const } })),
    ],
  };

  const erased: Record<string, number> = {};
  let hexclave: { id: string; delete: () => Promise<void> }[] = [];
  if (has("account")) hexclave = await hexclaveIdentities(users, email);

  if (!options.execute) {
    if (has("aiResults")) erased.aiResults = aiKeys.length ? await prisma.aiResult.count({ where: { subjectKey: { in: aiKeys } } }) : 0;
    if (has("auditEvents")) erased.auditEvents = mentions.length ? await prisma.auditEvent.count({ where: auditWhere }) : 0;
    if (has("prChecks")) erased.prChecks = prCheckIds.length;
    if (has("applications")) erased.applications = appIds.length;
    if (has("account")) {
      erased.notifications = await prisma.notification.count({ where: { userId: { in: userIds } } });
      erased.users = userIds.length;
    }
    return report(false);
  }

  if (has("account")) {
    for (const u of users) await closeAccount({ id: u.id, email: u.email });
  }

  await prisma.$transaction(async (tx) => {
    if (has("aiResults")) {
      erased.aiResults = aiKeys.length ? (await tx.aiResult.deleteMany({ where: { subjectKey: { in: aiKeys } } })).count : 0;
    }
    if (has("auditEvents")) {
      erased.auditEvents = mentions.length ? (await tx.auditEvent.deleteMany({ where: auditWhere })).count : 0;
    }
    if (has("prChecks")) {
      erased.prChecks = (await tx.prCheck.deleteMany({ where: { id: { in: prCheckIds } } })).count;
    }
    for (const d of denialRecords) {
      const existing = await tx.manualDecision.findUnique({
        where: { projectId_ghLogin: { projectId: d.projectId, ghLogin: d.ghLogin } },
        select: { id: true },
      });
      if (!existing) {
        await tx.manualDecision.create({
          data: { projectId: d.projectId, ghLogin: d.ghLogin, ghId: d.ghId, status: "DENIED", reason: d.reason },
        });
      }
    }
    if (has("applications")) {
      erased.applications = (await tx.application.deleteMany({ where: { id: { in: appIds } } })).count;
    }
    if (has("account")) {
      erased.notifications = (await tx.notification.deleteMany({ where: { userId: { in: userIds } } })).count;
      erased.users = (await tx.user.deleteMany({ where: { id: { in: userIds } } })).count;
    }
  });

  let deletedIdentities = 0;
  for (const identity of hexclave) {
    try {
      await identity.delete();
      deletedIdentities += 1;
    } catch (error) {
      logger.error({ err: error, requestRef: options.requestRef }, "erasure: deleting a Hexclave identity failed");
    }
  }
  erased.hexclaveIdentities = deletedIdentities;

  await recordAudit({
    projectId: null,
    actorId: null,
    kind: "privacy.erasure",
    payload: { requestRef: options.requestRef, categories, erased, denialRecords: denialRecords.length },
  });
  return report(true);

  function report(executed: boolean): ErasureReport {
    return {
      requestRef: options.requestRef,
      executed,
      categories,
      found: {
        users: users.length,
        applications: applications.length,
        prChecks: prChecks.length,
        signatures,
        manualDecisions,
      },
      erased,
      denialRecords,
      hexclaveIdentities: hexclave.length,
      kept: [
        ...(signatures > 0 ? [NEVER_ERASED[0]] : []),
        ...(manualDecisions > 0 ? [NEVER_ERASED[1]] : []),
        ...denialRecords.map(() => ({
          what: "A manual DENIED decision for the login",
          why: "The denial still binds, so the gate keeps refusing the login; nothing else of the application stays.",
        })),
      ],
    };
  }
}

/**
 * The person's identities in this instance's Hexclave project: the one each
 * account links to, and any other with the same email address (a second
 * sign-up leaves a second identity that no local row points at).
 *
 * Hexclave's REST API rather than `@hexclave/next`: the SDK imports
 * `next/navigation`, which does not resolve under plain Node, and this also
 * runs from the bundled CLI.
 */
async function hexclaveIdentities(
  users: { stackUserId: string | null; email: string | null }[],
  email: string | null,
): Promise<{ id: string; delete: () => Promise<void> }[]> {
  if (!env.stackConfigured) return [];
  const base = (process.env.STACK_API_URL ?? "https://api.stack-auth.com").replace(/\/+$/, "");
  const secret = await getSecret("STACK_SECRET_SERVER_KEY");
  if (!secret) throw new Error("STACK_SECRET_SERVER_KEY is not available, so Hexclave identities cannot be read");
  const headers = {
    "x-stack-access-type": "server",
    "x-stack-project-id": process.env.STACK_PROJECT_ID ?? "",
    "x-stack-secret-server-key": secret,
  };
  const call = async (path: string, method = "GET") => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers, cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Hexclave ${method} ${path.split("?")[0]} answered ${response.status}`);
    return method === "DELETE" ? {} : ((await response.json()) as Record<string, unknown>);
  };

  const ids = new Set<string>();
  for (const u of users) {
    if (u.stackUserId && (await call(`/users/${encodeURIComponent(u.stackUserId)}`))) ids.add(u.stackUserId);
  }
  const addresses = new Set([email, ...users.map((u) => u.email?.toLowerCase() ?? null)].filter(Boolean) as string[]);
  for (const address of addresses) {
    const page = await call(`/users?query=${encodeURIComponent(address)}&limit=20`);
    const items = (page?.items ?? []) as { id: string; primary_email?: string | null }[];
    for (const item of items) {
      if (item.primary_email?.toLowerCase() === address) ids.add(item.id);
    }
  }
  return [...ids].map((id) => ({
    id,
    delete: async () => {
      await call(`/users/${encodeURIComponent(id)}`, "DELETE");
    },
  }));
}
