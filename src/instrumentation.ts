import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Warm the Vault secret cache fire-and-forget so the first webhook or
    // sign-in is already warm and holds a last-known-good value. Never awaited
    // (must not block boot) and never throws (warmupSecrets swallows errors).
    if (process.env.VAULT_ADDR) {
      void import("@/lib/vault/resolver")
        .then(({ warmupSecrets }) => warmupSecrets())
        .catch(() => {
          /* never crash boot on a warmup failure */
        });
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
