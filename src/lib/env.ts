import { z } from "zod";

const csv = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),

  AUTH_SECRET: z.string().min(16),
  AUTH_URL: z.string().url().optional(),
  AUTH_TRUST_HOST: z.string().optional(),

  // Optional: only set if you want a *separate* OAuth App for human sign-in.
  // If empty, the GitHub App's client_id/secret are used instead.
  AUTH_GITHUB_ID: z.string().optional(),
  AUTH_GITHUB_SECRET: z.string().optional(),

  // GitHub App — optional at boot; required before any repo automation works.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().default("contribution-checker"),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),

  SUPER_ADMINS: z.string().optional(),
  PROJECT_CREATORS: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

const raw = parsed.data;

// Single-App mode: use the GitHub App's OAuth client credentials for sign-in
// when no separate OAuth App is configured.
const oauthClientId = raw.AUTH_GITHUB_ID || raw.GITHUB_APP_CLIENT_ID || "";
const oauthClientSecret =
  raw.AUTH_GITHUB_SECRET || raw.GITHUB_APP_CLIENT_SECRET || "";

// We *don't* throw when OAuth creds are missing — the operator might be in
// the middle of single-App bootstrap (no GH App yet, no OAuth App yet). The
// /admin/setup page falls back to SETUP_TOKEN for that one-time flow. After
// the GH App exists and credentials are pasted into .env, sign-in works.
const oauthConfigured = !!oauthClientId && !!oauthClientSecret;

export const env = {
  ...raw,
  oauthClientId,
  oauthClientSecret,
  oauthConfigured,
  superAdmins: csv(raw.SUPER_ADMINS).map((s) => s.toLowerCase()),
  projectCreators: csv(raw.PROJECT_CREATORS).map((s) => s.toLowerCase()),
  githubAppConfigured:
    !!raw.GITHUB_APP_ID && !!raw.GITHUB_APP_PRIVATE_KEY && !!raw.GITHUB_APP_WEBHOOK_SECRET,
  smtpConfigured: !!raw.SMTP_HOST && !!raw.SMTP_FROM,
};

export type Env = typeof env;
