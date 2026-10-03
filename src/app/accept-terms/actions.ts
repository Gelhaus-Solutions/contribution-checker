"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { recordAcceptance } from "@/lib/gpterms";
import { acceptTermsPath, safeNext, TERMS_ANSWER_COOKIE } from "@/lib/terms";

/**
 * Records an acceptance of exactly the versions the page showed.
 *
 * The page posts the identifier it rendered. If the versions moved on between
 * the render and the click (a rollout date passed), the person is shown the
 * page again rather than recorded against text they did not see.
 *
 * The row here is written first; GPlatform Terms' ledger gets the same
 * acceptance through the outbox, so a Terms that is away loses nothing.
 */
export async function acceptTermsAction(formData: FormData): Promise<void> {
  const session = await auth();
  const next = safeNext(formData.get("next"));
  if (!session?.user) redirect("/handler/sign-in");
  if (session.user.restricted) redirect("/restricted");
  const terms = session.user.terms;
  if (!terms) redirect(next);

  const shown = String(formData.get("record") ?? "");
  if (shown !== terms.record) redirect(acceptTermsPath(next));

  const row = await prisma.termsAcceptance.create({
    data: {
      userId: session.user.id,
      version: terms.record,
      source: terms.kind === "first" ? "first-sign-in" : "accept-screen",
    },
  });
  await recordAudit({
    projectId: null,
    actorId: session.user.id,
    kind: "terms.accepted",
    payload: { version: terms.record, from: terms.kind },
  });
  await recordAcceptance({
    userId: session.user.id,
    email: session.user.email || null,
    recorded: terms.record,
    acceptedAt: row.acceptedAt,
    first: terms.kind === "first",
  });
  redirect(next);
}

/**
 * "Not now" while a version is only announced, and "Continue read-only" once it
 * binds: remembered for this browser session against the versions asked about,
 * so the page comes back when they change or the browser is closed. Neither
 * records anything, and a restricted account stays restricted.
 */
export async function deferTermsAction(formData: FormData): Promise<void> {
  const session = await auth();
  const next = safeNext(formData.get("next"));
  if (!session?.user) redirect("/handler/sign-in");
  const terms = session.user.terms;
  if (!terms || (terms.kind !== "asked" && terms.kind !== "restricted")) redirect(next);

  (await cookies()).set(TERMS_ANSWER_COOKIE, terms.record, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.PUBLIC_BASE_URL.startsWith("https://"),
    path: "/",
  });
  redirect(next);
}
