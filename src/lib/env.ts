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

  // OpenRouter: the AI features (application triage, PR/QA summaries, release
  // narrative, the AI quality signal). The API key is deliberately NOT in this
  // typed object: it is resolved with getSecret("OPENROUTER_API_KEY") inside the
  // Temporal activity that calls the model, so it can live in Vault and never
  // reaches workflow history. Only the non-secret routing config is typed here.
  //
  // Two tiers, because only one of the four tasks does real synthesis. The cheap
  // tier handles triage, QA steps and the quality signal (short context,
  // constrained JSON, the regime where a small model is close to a large one).
  // The judgment tier is used by the release narrative alone. In development
  // both are normally pinned to the cheap model to protect the spend cap.
  //
  // Both default to gpt-oss-120b, chosen by measurement rather than price list:
  // it passed all seven task cases including the prompt-injection case that this
  // subsystem's safety rests on, and under a Groq BYOK key OpenRouter reports a
  // cost of zero. Gemini 3.5 Flash Lite is the proven fallback (same seven
  // passes, roughly 4x the cost) and 3.7 Flash is the judgment-tier option,
  // though it returned intermittent 503s throughout development.
  //
  // Do NOT reach for a Gemini 2.5 slug however cheap the rate card looks. Google
  // retired that line for new users and a BYOK key gets a 404 pointing at 3.5.
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  AI_MODEL_CHEAP: z.string().default("openai/gpt-oss-120b"),
  AI_MODEL_JUDGMENT: z.string().default("openai/gpt-oss-120b"),
  // Caps the completion. Sized for a REASONING model, which is why it looks
  // generous next to answers that render as a hundred tokens of JSON: gpt-oss
  // spends most of its completion thinking (measured: 742 output tokens for a
  // QA-steps answer, against ~110 from Gemini for the same input), and thinking
  // is billed as output. Too low a cap does not save money, it truncates the
  // JSON mid-object and turns a good answer into a recorded schema failure.
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2048),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

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

  // Worker Deployments / Worker Versioning (https://docs.temporal.io/worker-deployments).
  // Opt-in: when enabled, the worker registers under a Deployment with a Build
  // ID, which powers safe rolling deploys + the worker/version heartbeats the
  // server tracks (needs `frontend.workerHeartbeatsEnabled: true` server-side).
  TEMPORAL_VERSIONING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Logical deployment name (stable across releases), e.g. "contribution-checker".
  TEMPORAL_DEPLOYMENT_NAME: z.string().default("contribution-checker"),
  // Build ID — unique per worker code version. Wire to the image tag / git sha
  // (e.g. the CI version "0.0.99" or commit). Required when versioning is on.
  TEMPORAL_BUILD_ID: z.string().optional(),
  // How in-flight workflows behave when a new Build ID is deployed:
  //  - AUTO_UPGRADE: migrate to the latest version on next task (good for the
  //    long-lived cooldown/entity workflows so old workers needn't linger).
  //  - PINNED: stay on the starting version until completion (old worker must
  //    keep running until they finish).
  TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR: z
    .enum(["AUTO_UPGRADE", "PINNED"])
    .default("AUTO_UPGRADE"),
  // Auto-promote this Build ID to the deployment's Current version once the
  // worker has registered. Removes the manual "Set Current" step — fine for a
  // single-worker setup; disable if you want to verify before shifting traffic.
  TEMPORAL_SET_CURRENT_ON_START: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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

// Build-phase placeholder for the only field that is required with no default.
// The image is built generic, with no env at all, so without this the fallback
// below cannot run the full schema.
const BUILD_PHASE_PLACEHOLDERS = {
  DATABASE_URL: "postgresql://placeholder/build-phase",
} as const;

// Note the deliberate use of the FULL schema here rather than
// `schema.partial()`. `.partial()` wraps every field in ZodOptional, which
// short-circuits on a missing key and therefore never reaches that field's
// `.default()`. That silently produced `PUBLIC_BASE_URL === undefined` in the
// container build (env-less), where locally it was always defined because a
// .env file made the strict parse succeed. Filling in the one required field
// keeps every other default intact.
const raw = parsed.success
  ? parsed.data
  : schema.parse({ ...BUILD_PHASE_PLACEHOLDERS, ...process.env });

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
  // The AI features need nothing but the key: model ids have defaults, and the
  // key may live in Vault, so this is a presence check rather than a read.
  // Every AI surface short-circuits on this the way the webhook path does for
  // GitHub, which is what makes the whole subsystem safe to leave unconfigured.
  aiConfigured: presentInEnvOrVault("OPENROUTER_API_KEY"),
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
