import { StackHandler } from "@hexclave/next";
import { getStackServerApp } from "@/lib/stack";

/**
 * Hexclave (Stack Auth) catch-all handler: renders sign-in, sign-up,
 * OAuth callback, account settings, email verification, etc. Replaces the old
 * `/api/auth/[...nextauth]` route.
 */
export default async function Handler(props: {
  params: Promise<{ stack?: string[] }>;
  searchParams: Promise<Record<string, string>>;
}) {
  return (
    <StackHandler fullPage app={await getStackServerApp()} routeProps={props} />
  );
}
