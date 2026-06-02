import "server-only";
import { StackServerApp } from "@hexclave/next";
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
      return new StackServerApp({
        tokenStore: "nextjs-cookie",
        baseUrl: process.env.NEXT_PUBLIC_STACK_API_URL,
        projectId: process.env.NEXT_PUBLIC_STACK_PROJECT_ID,
        publishableClientKey:
          process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY,
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
