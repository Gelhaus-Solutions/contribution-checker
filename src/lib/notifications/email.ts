import nodemailer from "nodemailer";
import { env } from "@/lib/env";
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

export function applyUrl(slug: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${slug}`;
}

export function dashboardUrl(path = ""): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Drop the cached transporter so the next sendEmail re-resolves SMTP secrets. */
export function invalidateMailTransporter(): void {
  transporter = null;
  cachedFrom = undefined;
}
