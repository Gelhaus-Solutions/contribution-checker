import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.smtpConfigured) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
  });
  return transporter;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  const t = getTransporter();
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
