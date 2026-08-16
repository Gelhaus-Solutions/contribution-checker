import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { getSecret } from "@/lib/vault/resolver";
import { logger } from "@/lib/logger";

let transporter: nodemailer.Transporter | null = null;
let cachedFrom: string | undefined;
let inflight: Promise<nodemailer.Transporter | null> | null = null;

const DEFAULT_SMTP_PORT = 587;

async function getTransporter(): Promise<nodemailer.Transporter | null> {
  if (!env.smtpConfigured) return null;
  if (transporter) return transporter;
  if (inflight) return inflight;

  inflight = (async () => {
    const [host, portStr, user, pass, from] = await Promise.all([
      getSecret("SMTP_HOST"),
      getSecret("SMTP_PORT"),
      getSecret("SMTP_USER"),
      getSecret("SMTP_PASS"),
      getSecret("SMTP_FROM"),
    ]);
    if (!host) return null;

    const port = portStr ? Number.parseInt(portStr, 10) : DEFAULT_SMTP_PORT;
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
    cachedFrom = from;
    return transporter;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  const t = await getTransporter();
  if (!t) {
    logger.debug({ to: args.to }, "SMTP not configured, skipping email");
    return false;
  }
  try {
    await t.sendMail({
      from: cachedFrom,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    return true;
  } catch (e) {
    logger.warn({ err: e, to: args.to }, "email delivery failed");
    return false;
  }
}

/**
 * Resolve a user's email and send them a message. No-ops when the user has no
 * email on file (and `sendEmail` itself no-ops when SMTP is unconfigured), so
 * callers can fire-and-forget. Used by the CLA applicant-reminder flow.
 */
export async function emailUserById(args: {
  userId: string;
  subject: string;
  text: string;
}): Promise<void> {
  const u = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { email: true },
  });
  if (!u?.email) return;
  await sendEmail({ to: u.email, subject: args.subject, text: args.text });
}

export function applyUrl(slug: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${slug}`;
}

/**
 * The public contributor explainer, linked from the PR comment a stranger sees
 * when the bot closes their pull request.
 *
 * Once this ships, the URL is quoted in comments across other people's
 * repositories indefinitely, so the route must not move, 404, or sit behind
 * auth. It reads no database, which is what makes that safe.
 */
export function contributorInfoUrl(): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/for-contributors`;
}

export function dashboardUrl(path = ""): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Drop the cached transporter so the next sendEmail re-resolves SMTP secrets. */
export function invalidateMailTransporter(): void {
  transporter = null;
  cachedFrom = undefined;
}
