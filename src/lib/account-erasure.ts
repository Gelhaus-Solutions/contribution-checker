import "server-only";
import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { closeAccount } from "@/lib/gpterms";
import { logger } from "@/lib/logger";
import { getSecret } from "@/lib/vault/resolver";

/**
 * Privacy requests (GDPR Art. 17, and Art. 21 after an objection): what
 * happens to one person's data, decided per kind of data.
 *
 * GPlatform Terms holds the request and the decision; this is Contribution
 * Checker's side of it. The catalogue says what this product holds about a
 * person and what it can do with each kind: keep it, pseudonymise it, or
 * delete it. A plan names one action per category; `runPrivacyPlan` carries it
 * out (or, in a dry run, counts what it would touch) and reports back.
 *
 * **Pseudonymising** replaces every identifier with a keyed hash
 * (HMAC-SHA256 under `PRIVACY_PSEUDONYM_KEY`), so the record stays and is
 * still consistent with itself, but no longer names anyone: the name, address
 * and image are cleared, the GitHub login becomes `anon-<hash>` and the GitHub
 * id a negative number derived from the same hash. A plain hash would not do:
 * anybody can hash a known login and match it. Without the key the hash
 * cannot be turned back, and with it only the person's own login matches.
 *
 * Two things are never touched here: a CLA signature, which is evidence of a
 * licence grant and is revoked rather than erased (the project decides), and a
 * project's manual decision about a login. The report lists them when found.
 */

export type PrivacyAction = "keep" | "pseudonymise" | "delete";

export interface PrivacyCategory {
  id: string;
  label: string;
  detail: string;
  actions: PrivacyAction[];
  default: PrivacyAction;
  /** Deleting this deletes these too (database cascades). */
  takesWithIt: string[];
}

export const PRIVACY_CATALOGUE: readonly PrivacyCategory[] = [
  {
    id: "account",
    label: "Account",
    detail:
      "Name, email address, image, GitHub login and id, and the sign-in identity in Hexclave. Pseudonymise keeps the account row with every identifier replaced, so applications and checks can stay; the Hexclave identity is deleted either way. Delete removes the account with its applications, notifications and memberships.",
    actions: ["keep", "pseudonymise", "delete"],
    default: "pseudonymise",
    takesWithIt: ["applications", "applicationText", "notifications"],
  },
  {
    id: "applications",
    label: "Applications",
    detail: "Each application to a project: its status, decision, cooldown and dates.",
    actions: ["keep", "delete"],
    default: "keep",
    takesWithIt: ["applicationText"],
  },
  {
    id: "applicationText",
    label: "What was written in applications",
    detail:
      "Application and appeal answers, appeal messages, the decision reason, and reviewers' notes and reviews.",
    actions: ["keep", "delete"],
    default: "delete",
    takesWithIt: [],
  },
  {
    id: "prChecks",
    label: "Pull request checks",
    detail:
      "Repository, pull request number, decision and check runs, recorded under the author's GitHub login and id. Pseudonymise replaces the login and id here; the pull request itself stays on GitHub.",
    actions: ["keep", "pseudonymise", "delete"],
    default: "pseudonymise",
    takesWithIt: ["prQuality"],
  },
  {
    id: "prQuality",
    label: "Quality-check results",
    detail: "Signals computed from the pull request and from the author's public GitHub profile.",
    actions: ["keep", "delete"],
    default: "delete",
    takesWithIt: [],
  },
  {
    id: "aiResults",
    label: "AI results",
    detail: "Answers a model gave about their applications and pull requests.",
    actions: ["keep", "delete"],
    default: "delete",
    takesWithIt: [],
  },
  {
    id: "notifications",
    label: "Notifications",
    detail: "Messages shown to the account.",
    actions: ["keep", "delete"],
    default: "delete",
    takesWithIt: [],
  },
  {
    id: "auditEvents",
    label: "Audit entries",
    detail:
      "What they did and what was done about them. Pseudonymise replaces their login and address inside the entries and keeps the events.",
    actions: ["keep", "pseudonymise", "delete"],
    default: "pseudonymise",
    takesWithIt: [],
  },
];

export type PrivacyPlan = Record<string, PrivacyAction>;

export interface PrivacySubject {
  email: string | null;
  identifiers: Record<string, string>;
  /** This product's account ids as GPlatform Terms knows them (`User.id`). */
  accountIds: string[];
}

export interface PrivacyReport {
  found: Record<string, number>;
  done: Record<string, { action: PrivacyAction; count: number }>;
  kept: { what: string; why: string }[];
  notes: string[];
}

/** Problems with a plan; empty when it names every category with an action it offers. */
export function planProblems(plan: PrivacyPlan): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(plan)) {
    if (!PRIVACY_CATALOGUE.some((one) => one.id === id)) problems.push(`unknown category ${id}`);
  }
  for (const category of PRIVACY_CATALOGUE) {
    const action = plan[category.id];
    if (action === undefined) problems.push(`no action for ${category.id}`);
    else if (!category.actions.includes(action)) problems.push(`${category.id} cannot be ${action}`);
    else if (action === "delete") {
      for (const taken of category.takesWithIt) {
        if (plan[taken] !== "delete") problems.push(`deleting ${category.id} deletes ${taken} too`);
      }
    }
  }
  return problems;
}

/** The keyed pseudonym of one identifier, and a negative GitHub id from the same hash. */
export function pseudonymOf(key: string, kind: string, value: string): { text: string; id: number } {
  const hash = createHmac("sha256", key).update(`${kind}:${value.trim().toLowerCase()}`).digest("hex");
  return { text: `anon-${hash.slice(0, 24)}`, id: -(Number.parseInt(hash.slice(0, 7), 16) + 1) };
}

export async function runPrivacyPlan(
  subject: PrivacySubject,
  plan: PrivacyPlan,
  options: { execute: boolean; requestRef: string },
): Promise<PrivacyReport> {
  const problems = planProblems(plan);
  if (problems.length > 0) throw new Error(`the plan cannot be carried out: ${problems.join("; ")}`);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(options.requestRef)) {
    throw new Error("the request reference must be short and carry no personal data");
  }
  const action = (id: string) => plan[id] as PrivacyAction;
  const email = subject.email?.trim().toLowerCase() || null;
  const github = subject.identifiers["github"]?.trim().toLowerCase() || null;

  const users = await prisma.user.findMany({
    where: {
      OR: [
        ...(subject.accountIds.length > 0 ? [{ id: { in: subject.accountIds } }] : []),
        ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
        ...(github ? [{ ghLogin: { equals: github, mode: "insensitive" as const } }] : []),
      ],
    },
    select: { id: true, email: true, ghLogin: true, ghId: true, stackUserId: true },
  });
  const userIds = users.map((u) => u.id);
  const logins = unique([github, ...users.map((u) => u.ghLogin?.toLowerCase() ?? null)]);
  const emails = unique([email, ...users.map((u) => u.email?.toLowerCase() ?? null)]);
  const ghIds = [
    ...new Set(users.map((u) => u.ghId).filter((v): v is number => typeof v === "number" && v > 0)),
  ];
  const byLogin = logins.map((l) => ({ equals: l, mode: "insensitive" as const }));

  const applications = await prisma.application.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const appIds = applications.map((a) => a.id);
  const prChecks = await prisma.prCheck.findMany({
    where: {
      OR: [
        ...byLogin.map((authorGhLogin) => ({ authorGhLogin })),
        ...(ghIds.length > 0 ? [{ authorGhId: { in: ghIds } }] : []),
      ],
    },
    select: { id: true },
  });
  const prCheckIds = prChecks.map((p) => p.id);
  const aiKeys = [...appIds.map((id) => `application:${id}`), ...prCheckIds.map((id) => `prcheck:${id}`)];
  const mentions = [...userIds, ...appIds, ...prCheckIds, ...logins, ...emails];
  const auditWhere: Prisma.AuditEventWhereInput = {
    OR: [
      ...(userIds.length > 0 ? [{ actorId: { in: userIds } }] : []),
      ...mentions.map((m) => ({ payload: { contains: m, mode: "insensitive" as const } })),
    ],
  };
  const none = Promise.resolve(0);
  const [appeals, notes, reviews, quality, ai, notifications, audits, staging, signatures, manualDecisions] =
    await Promise.all([
      appIds.length ? prisma.applicationAppeal.count({ where: { applicationId: { in: appIds } } }) : none,
      appIds.length ? prisma.applicationNote.count({ where: { applicationId: { in: appIds } } }) : none,
      appIds.length ? prisma.applicationReview.count({ where: { applicationId: { in: appIds } } }) : none,
      prCheckIds.length ? prisma.prQuality.count({ where: { prCheckId: { in: prCheckIds } } }) : none,
      aiKeys.length ? prisma.aiResult.count({ where: { subjectKey: { in: aiKeys } } }) : none,
      userIds.length ? prisma.notification.count({ where: { userId: { in: userIds } } }) : none,
      mentions.length ? prisma.auditEvent.count({ where: auditWhere }) : none,
      logins.length ?
        prisma.stagingBatchItem.count({ where: { OR: byLogin.map((authorLogin) => ({ authorLogin })) } })
      : none,
      logins.length ? prisma.claSignature.count({ where: { OR: byLogin.map((ghLogin) => ({ ghLogin })) } }) : none,
      logins.length ? prisma.manualDecision.count({ where: { ghLogin: { in: logins } } }) : none,
    ]);

  const found: Record<string, number> = {
    account: users.length,
    applications: appIds.length,
    applicationText: appIds.length + appeals + notes + reviews,
    prChecks: prCheckIds.length + staging,
    prQuality: quality,
    aiResults: ai,
    notifications,
    auditEvents: audits,
  };
  const kept = [
    ...(signatures > 0 ?
      [
        {
          what: "CLA signatures",
          why: "Evidence of a licence grant: revoked rather than erased, and erasing one is the project's decision.",
        },
      ]
    : []),
    ...(manualDecisions > 0 ?
      [{ what: "Manual decisions about the login", why: "A project's own decision; the project removes it." }]
    : []),
  ];
  const notes2: string[] = [];
  const wantsKey = Object.values(plan).includes("pseudonymise");
  const key = wantsKey ? await getSecret("PRIVACY_PSEUDONYM_KEY") : null;
  if (wantsKey && !key) {
    if (options.execute) {
      throw new Error("PRIVACY_PSEUDONYM_KEY is not available, so nothing can be pseudonymised");
    }
    notes2.push("PRIVACY_PSEUDONYM_KEY is not available: carrying this plan out would fail until it is set.");
  }

  const done: PrivacyReport["done"] = {};
  if (!options.execute) {
    for (const category of PRIVACY_CATALOGUE) {
      done[category.id] = {
        action: action(category.id),
        count: action(category.id) === "keep" ? 0 : (found[category.id] ?? 0),
      };
    }
    return { found, done, kept, notes: notes2 };
  }

  const pseudo = (kind: string, value: string) => pseudonymOf(key as string, kind, value);
  if (action("account") !== "keep") {
    for (const u of users) await closeAccount({ id: u.id, email: u.email });
  }

  await prisma.$transaction(async (tx) => {
    const count = (id: string, n: number) => {
      done[id] = { action: action(id), count: n };
    };

    count(
      "aiResults",
      action("aiResults") === "delete" && aiKeys.length ?
        (await tx.aiResult.deleteMany({ where: { subjectKey: { in: aiKeys } } })).count
      : 0,
    );
    count(
      "prQuality",
      action("prQuality") === "delete" && prCheckIds.length ?
        (await tx.prQuality.deleteMany({ where: { prCheckId: { in: prCheckIds } } })).count
      : 0,
    );

    if (action("prChecks") === "delete") {
      const removed = (await tx.prCheck.deleteMany({ where: { id: { in: prCheckIds } } })).count;
      count("prChecks", removed + (await scrubStaging(tx, logins, null)));
    } else if (action("prChecks") === "pseudonymise") {
      const p = pseudo("github", logins[0] ?? userIds[0] ?? "unknown");
      const n = (
        await tx.prCheck.updateMany({
          where: { id: { in: prCheckIds } },
          data: { authorGhLogin: p.text, authorGhId: p.id },
        })
      ).count;
      count("prChecks", n + (await scrubStaging(tx, logins, p.text)));
    } else count("prChecks", 0);

    if (action("auditEvents") === "delete") {
      count("auditEvents", mentions.length ? (await tx.auditEvent.deleteMany({ where: auditWhere })).count : 0);
    } else if (action("auditEvents") === "pseudonymise") {
      const rows =
        mentions.length ?
          await tx.auditEvent.findMany({ where: auditWhere, select: { id: true, payload: true } })
        : [];
      for (const row of rows) {
        let payload = row.payload;
        for (const login of logins) payload = replaceAll(payload, login, pseudo("github", login).text);
        for (const address of emails) payload = replaceAll(payload, address, pseudo("email", address).text);
        if (payload !== row.payload) await tx.auditEvent.update({ where: { id: row.id }, data: { payload } });
      }
      count("auditEvents", rows.length);
    } else count("auditEvents", 0);

    if (action("applications") === "delete") {
      count("applications", (await tx.application.deleteMany({ where: { id: { in: appIds } } })).count);
      count("applicationText", appIds.length + appeals + notes + reviews);
    } else {
      count("applications", 0);
      if (action("applicationText") === "delete" && appIds.length > 0) {
        await tx.application.updateMany({ where: { id: { in: appIds } }, data: { answers: "{}", reason: null } });
        await tx.applicationAppeal.updateMany({
          where: { applicationId: { in: appIds } },
          data: { message: "", answers: "{}", resolutionNote: null },
        });
        const n = (await tx.applicationNote.deleteMany({ where: { applicationId: { in: appIds } } })).count;
        const m = (await tx.applicationReview.deleteMany({ where: { applicationId: { in: appIds } } })).count;
        count("applicationText", appIds.length + appeals + n + m);
      } else count("applicationText", 0);
    }

    count(
      "notifications",
      action("notifications") === "delete" && userIds.length ?
        (await tx.notification.deleteMany({ where: { userId: { in: userIds } } })).count
      : 0,
    );

    if (action("account") === "delete") {
      count("account", (await tx.user.deleteMany({ where: { id: { in: userIds } } })).count);
    } else if (action("account") === "pseudonymise") {
      for (const u of users) {
        const p = pseudo("github", u.ghLogin ?? u.id);
        await tx.user.update({
          where: { id: u.id },
          data: {
            name: null,
            email: null,
            emailVerified: null,
            image: null,
            country: null,
            stackUserId: null,
            ghLogin: p.text,
            ghId: p.id,
          },
        });
      }
      count("account", users.length);
    } else count("account", 0);
  });

  if (action("account") !== "keep") {
    const removed = await deleteHexclaveIdentities(users, emails);
    notes2.push(`Sign-in identities deleted in Hexclave: ${String(removed)}.`);
  }

  await recordAudit({
    projectId: null,
    actorId: null,
    kind: "privacy.erasure",
    payload: { requestRef: options.requestRef, plan, done },
  });
  return { found, done, kept, notes: notes2 };
}

/** Release manifests name merged PRs' authors: replaced by the pseudonym, or cleared. */
async function scrubStaging(
  tx: Prisma.TransactionClient,
  logins: string[],
  replacement: string | null,
): Promise<number> {
  let n = 0;
  for (const login of logins) {
    n += (
      await tx.stagingBatchItem.updateMany({
        where: { authorLogin: { equals: login, mode: "insensitive" } },
        data: { authorLogin: replacement },
      })
    ).count;
  }
  return n;
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/** Case-insensitive replacement of a literal, for JSON text where a login may appear in any case. */
function replaceAll(text: string, needle: string, replacement: string): string {
  return text.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), replacement);
}

/**
 * The person's identities in this instance's Hexclave project, deleted: the
 * one each account links to, and any other with the same address (a second
 * sign-up leaves one no local row points at). Over Hexclave's REST API, since
 * `@hexclave/next` imports `next/navigation`, which plain Node cannot resolve.
 */
async function deleteHexclaveIdentities(
  users: { stackUserId: string | null }[],
  emails: string[],
): Promise<number> {
  if (!env.stackConfigured) return 0;
  const base = (process.env.STACK_API_URL ?? "https://api.stack-auth.com").replace(/\/+$/, "");
  const secret = await getSecret("STACK_SECRET_SERVER_KEY");
  if (!secret) throw new Error("STACK_SECRET_SERVER_KEY is not available, so Hexclave identities cannot be deleted");
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
  const ids = new Set(users.map((u) => u.stackUserId).filter((v): v is string => !!v));
  for (const address of emails) {
    const page = await call(`/users?query=${encodeURIComponent(address)}&limit=20`);
    for (const item of (page?.items ?? []) as { id: string; primary_email?: string | null }[]) {
      if (item.primary_email?.toLowerCase() === address) ids.add(item.id);
    }
  }
  let removed = 0;
  for (const id of ids) {
    try {
      if ((await call(`/users/${encodeURIComponent(id)}`, "DELETE")) !== null) removed += 1;
    } catch (error) {
      logger.error({ err: error }, "privacy: deleting a Hexclave identity failed");
      throw error;
    }
  }
  return removed;
}
