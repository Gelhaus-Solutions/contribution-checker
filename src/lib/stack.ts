import "server-only";
import { StackAdminApp, StackServerApp } from "@hexclave/next";
import { getSecret } from "@/lib/vault/resolver";

// Re-export the shared constants so existing importers of "@/lib/stack" keep
// working; definitions live in the non-server-only constants module so the
// backfill script can use them too.
export {
  SUPER_ADMIN_PERMISSION,
  CREATE_PROJECT_PERMISSION,
  GITHUB_PROVIDER_CONFIG_ID,
  GITHUB_OAUTH_SCOPES,
} from "@/lib/auth/constants";

/**
 * Hexclave (self-hosted Stack Auth fork) server app. This is the single place
 * the app talks to Hexclave with server credentials.
 *
 * The secret server key may live in Vault, so we resolve it via `getSecret`
 * (mirroring the function-form secret resolution the old NextAuth config used).
 * Construction is lazy + memoized: the module can be imported during build and
 * in tests without a configured Hexclave instance; the instance is only built
 * on first real use.
 *
 * `tokenStore: "nextjs-cookie"` makes this a `StackServerApp<true>` that reads
 * the session from the request cookies (the cookie-session model chosen for the
 * migration). The same instance is passed to `<StackProvider>` in the root
 * layout, so the browser only ever receives the client-safe projection.
 */

let cached: Promise<StackServerApp<true>> | null = null;

export function getStackServerApp(): Promise<StackServerApp<true>> {
  if (!cached) {
    cached = (async () => {
      const secretServerKey = await getSecret("STACK_SECRET_SERVER_KEY");
      // Read at runtime (server-side) so a single CI-built image can be
      // configured per-deployment. These reach the browser via
      // <StackProvider>'s toClientJson serialization, not build-time inlining.
      return new StackServerApp({
        tokenStore: "nextjs-cookie",
        baseUrl: process.env.STACK_API_URL,
        projectId: process.env.STACK_PROJECT_ID,
        publishableClientKey: process.env.STACK_PUBLISHABLE_CLIENT_KEY,
        secretServerKey,
        urls: {
          afterSignIn: "/dashboard",
          afterSignUp: "/welcome",
          afterSignOut: "/",
        },
      });
    })();
  }
  return cached;
}

let cachedAdmin: Promise<StackAdminApp<true>> | null = null;

/**
 * Hexclave admin app. Unlike the server app this is NOT bound to a request
 * session (`tokenStore: "memory"`); it carries the super-secret admin key and
 * is only used off the hot path to manage permission DEFINITIONS (the project
 * permission hierarchy) and the Instance Admin team (see stack-provisioning.ts).
 *
 * Lazy + memoized like getStackServerApp. Throws a clear error if the admin key
 * is missing so provisioning/bootstrap fails loudly instead of silently calling
 * Hexclave without admin authority.
 */
export function getStackAdminApp(): Promise<StackAdminApp<true>> {
  if (!cachedAdmin) {
    cachedAdmin = (async () => {
      const secretServerKey = await getSecret("STACK_SECRET_SERVER_KEY");
      const superSecretAdminKey = await getSecret("STACK_SUPER_SECRET_ADMIN_KEY");
      if (!superSecretAdminKey) {
        throw new Error(
          "STACK_SUPER_SECRET_ADMIN_KEY is not configured; cannot build the Hexclave admin app",
        );
      }
      return new StackAdminApp({
        tokenStore: "memory",
        baseUrl: process.env.STACK_API_URL,
        projectId: process.env.STACK_PROJECT_ID,
        publishableClientKey: process.env.STACK_PUBLISHABLE_CLIENT_KEY,
        secretServerKey,
        superSecretAdminKey,
      });
    })();
  }
  return cachedAdmin;
}
