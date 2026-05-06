import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { getSecret } from "@/lib/vault/resolver";
import { logger } from "@/lib/logger";

let transporter: nodemailer.Transporter | null = null;
let inflight: Promise<nodemailer.Transporter | null> | null = null;

async function getTransporter(): Promise<nodemailer.Transporter | null> {
  if (!env.smtpConfigured) return null;
  if (transporter) return transporter;
  if (inflight) return inflight;

  inflight = (async () => {
    const [user, pass] = await Promise.all([
      getSecret("SMTP_USER"),
      getSecret("SMTP_PASS"),
    ]);
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
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
      from: env.SMTP_FROM,
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

export function applyUrl(slug: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${slug}`;
}

export function dashboardUrl(path = ""): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Drop the cached transporter so the next sendEmail re-resolves SMTP_USER/PASS. */
export function invalidateMailTransporter(): void {
  transporter = null;
}
