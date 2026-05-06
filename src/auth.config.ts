import type { NextAuthConfig } from "next-auth";

/**
 * Static base config (no providers). Providers are constructed in src/auth.ts
 * via NextAuth's function-form so we can resolve OAuth client credentials
 * through the Vault-aware secret resolver at request time.
 */
export const authConfig = {
  trustHost: true,
  session: { strategy: "database" },
  providers: [],
  // No `authorized` middleware callback: we use database-backed sessions,
  // which can't be looked up in the edge runtime. Each protected server page
  // calls `requireSession()` itself.
} satisfies NextAuthConfig;
