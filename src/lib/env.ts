import { z } from "zod";
import { getVaultPathFor } from "@/lib/vault/config";

// A secret is "configured" if it's set in process.env OR has a VAULT_<name>_PATH
// pointing into Vault. We can't await secret resolution from this module
// (it's loaded synchronously by Next.js), so we use this presence check for
// derived flags like `githubAppConfigured`.
const presentInEnvOrVault = (name: string): boolean =>
  !!process.env[name] || !!getVaultPathFor(name);

const csv = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  // Legacy NextAuth vars. No longer used after the Hexclave migration (login is
  // handled by Hexclave); kept optional for backward compat and removed in the
  // post-cutover cleanup. AUTH_SECRET is no longer required.
  AUTH_SECRET: z.string().min(16).optional(),
  AUTH_URL: z.string().url().optional(),
  AUTH_TRUST_HOST: z.string().optional(),

  // Optional: only set if you want a *separate* OAuth App for human sign-in.
  // If empty, the GitHub App's client_id/secret are used instead.
  AUTH_GITHUB_ID: z.string().optional(),
  AUTH_GITHUB_SECRET: z.string().optional(),

  // GitHub App: optional at boot; required before any repo automation works.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().default("contribution-checker"),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),

  SUPER_ADMINS: z.string().optional(),
  PROJECT_CREATORS: z.string().optional(),

  // Hexclave (self-hosted Stack Auth fork) — human login. Deliberately NOT
  // prefixed NEXT_PUBLIC_: the project id and publishable client key are
  // public, but we ship a single generic Docker image built in CI and configure
  // it at container runtime, so nothing may be inlined at `next build`. These
  // are read server-side at runtime and reach the browser via <StackProvider>'s
  // toClientJson serialization (runtime), not via build-time inlining. The
  // secret server key may live in Vault (resolved via getSecret at request
  // time). STACK_API_URL points the SDK at the operator's self-hosted backend.
  STACK_PROJECT_ID: z.string().optional(),
  STACK_PUBLISHABLE_CLIENT_KEY: z.string().optional(),
  STACK_SECRET_SERVER_KEY: z.string().optional(),
  STACK_API_URL: z.string().url().optional(),
  // Svix signing secret for verifying Hexclave webhooks (user.created, etc.).
  STACK_WEBHOOK_SECRET: z.string().optional(),
  // Super-secret admin key for the StackAdminApp. Required only for managing
  // permission DEFINITIONS (the project permission hierarchy) and the Instance
  // Admin team; the normal request path never needs it. May live in Vault.
  STACK_SUPER_SECRET_ADMIN_KEY: z.string().optional(),
  // Optional pin for the Instance Admin team. When unset, the team is discovered
  // by its server-only `instanceAdmin` metadata marker (see stack-provisioning).
  STACK_INSTANCE_ADMIN_TEAM_ID: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Sentry: observability. Sample rates are hardcoded to 1.0 in
  // sentry.server.config.ts / instrumentation-client.ts; the SDK no-ops
  // when DSN is missing so all of these stay optional.
  SENTRY_DSN: z.string().url().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  // Sentry CSP/Expect-CT report ingest URL (project Settings → Security
  // Headers → CSP Reports). When set, included in the response CSP as
  // `report-uri` / `report-to` so violations stream to Sentry. NOT used for
  // event/replay uploads (those go to the SDK's transport, separately).
  SENTRY_CSP_ENDPOINT: z.string().url().optional(),

  // HashiCorp Vault: non-secret config only. Auth credentials (VAULT_TOKEN,
  // VAULT_APPROLE_*) are deliberately NOT in this typed object so they can
  // never be accidentally serialized; they're read directly from process.env
  // inside src/lib/vault/config.ts.
  VAULT_ADDR: z.string().url().optional(),
  VAULT_NAMESPACE: z.string().optional(),
  VAULT_AUTH_METHOD: z.enum(["token", "approle"]).optional(),
  VAULT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  VAULT_REVALIDATE_INTERVAL_SECONDS: z.coerce.number().int().min(0).optional(),
  VAULT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  VAULT_MAX_RETRIES: z.coerce.number().int().min(0).optional(),
  VAULT_BREAKER_THRESHOLD: z.coerce.number().int().positive().optional(),
  VAULT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().optional(),

  // Temporal: durable execution backend. The worker and the Next.js client both
  // connect to TEMPORAL_HOST:TEMPORAL_PORT. In production the connection is
  // mTLS-secured; the client cert/key/CA are resolved from Vault at startup
  // (TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY / TEMPORAL_TLS_CA secret names), so
  // they are not in this typed object. Local dev points at `temporal
  // server start-dev` with TLS disabled.
  TEMPORAL_HOST: z.string().default("localhost"),
  TEMPORAL_PORT: z.coerce.number().int().positive().default(7233),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("contribution-checker"),
  TEMPORAL_TLS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Optional SNI / server name override for mTLS verification (when the cert CN
  // differs from TEMPORAL_HOST, e.g. behind a load balancer).
  TEMPORAL_TLS_SERVER_NAME: z.string().optional(),
});

// During `next build`, Next.js executes server modules to collect page data
// even though no request is being served. Skip strict validation in that
// phase. Env will be validated again on first real request, and any missing
// values will surface there with the same error.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

const parsed = schema.safeParse(process.env);

if (!parsed.success && !isBuildPhase) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

const raw = parsed.success
  ? parsed.data
  : (schema.partial().parse(process.env) as z.infer<typeof schema>);

// Single-App mode: use the GitHub App's OAuth client credentials for sign-in
// when no separate OAuth App is configured. These string values are only used
// for the env-only fallback path; when Vault is configured for these names,
// auth.config.ts resolves them via getSecret() at request time instead.
const oauthClientId = raw.AUTH_GITHUB_ID || raw.GITHUB_APP_CLIENT_ID || "";
const oauthClientSecret =
  raw.AUTH_GITHUB_SECRET || raw.GITHUB_APP_CLIENT_SECRET || "";

// "Configured" is true when EITHER an env var is set OR a Vault path points
// at the secret. This lets the webhook handler short-circuit correctly when
// secrets live in Vault and env is empty.
const oauthConfigured =
  (presentInEnvOrVault("AUTH_GITHUB_ID") ||
    presentInEnvOrVault("GITHUB_APP_CLIENT_ID")) &&
  (presentInEnvOrVault("AUTH_GITHUB_SECRET") ||
    presentInEnvOrVault("GITHUB_APP_CLIENT_SECRET"));

export const env = {
  ...raw,
  oauthClientId,
  oauthClientSecret,
  oauthConfigured,
  superAdmins: csv(raw.SUPER_ADMINS).map((s) => s.toLowerCase()),
  projectCreators: csv(raw.PROJECT_CREATORS).map((s) => s.toLowerCase()),
  // Hexclave is "configured" when the public identifiers are present and the
  // secret server key is available (env or Vault). The auth layer short-circuits
  // when this is false the same way the webhook path does for GitHub.
  stackConfigured:
    !!raw.STACK_PROJECT_ID &&
    !!raw.STACK_PUBLISHABLE_CLIENT_KEY &&
    presentInEnvOrVault("STACK_SECRET_SERVER_KEY"),
  // Admin-app capable: the StackAdminApp can be built (permission-definition
  // provisioning + Instance Admin team management). The hot path never needs
  // this; provisioning/bootstrap short-circuits with a log when it's false.
  stackAdminConfigured:
    !!raw.STACK_PROJECT_ID &&
    !!raw.STACK_PUBLISHABLE_CLIENT_KEY &&
    presentInEnvOrVault("STACK_SECRET_SERVER_KEY") &&
    presentInEnvOrVault("STACK_SUPER_SECRET_ADMIN_KEY"),
  githubAppConfigured:
    presentInEnvOrVault("GITHUB_APP_ID") &&
    presentInEnvOrVault("GITHUB_APP_PRIVATE_KEY") &&
    presentInEnvOrVault("GITHUB_APP_WEBHOOK_SECRET"),
  smtpConfigured:
    presentInEnvOrVault("SMTP_HOST") && presentInEnvOrVault("SMTP_FROM"),
  vaultEnabled: !!raw.VAULT_ADDR,
  // Temporal is "configured" when a host is set. mTLS material is checked
  // separately at connect time (see src/lib/temporal/connection.ts): when
  // TEMPORAL_TLS_ENABLED is true the cert/key are required, resolved from env
  // or Vault.
  temporalConfigured: !!raw.TEMPORAL_HOST,
  temporalTlsConfigured:
    !raw.TEMPORAL_TLS_ENABLED ||
    (presentInEnvOrVault("TEMPORAL_TLS_CERT") &&
      presentInEnvOrVault("TEMPORAL_TLS_KEY")),
};

export type Env = typeof env;
