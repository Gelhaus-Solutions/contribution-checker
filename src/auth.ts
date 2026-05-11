import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSecret } from "@/lib/vault/resolver";
import { authConfig } from "@/auth.config";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      ghLogin?: string | null;
      ghId?: number | null;
      isSuperAdmin: boolean;
      canCreateProj: boolean;
    };
  }
}

// NextAuth v5 supports a function-form config so we can `await` secret
// resolution before constructing providers. The function runs once per
// auth-handler invocation; the resolver caches secret values so the cost is
// near-zero after the first call.
export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  let authGhId: string | undefined,
    authGhSecret: string | undefined,
    appClientId: string | undefined,
    appClientSecret: string | undefined;
  try {
    [authGhId, authGhSecret, appClientId, appClientSecret] = await Promise.all([
      getSecret("AUTH_GITHUB_ID"),
      getSecret("AUTH_GITHUB_SECRET"),
      getSecret("GITHUB_APP_CLIENT_ID"),
      getSecret("GITHUB_APP_CLIENT_SECRET"),
    ]);
  } catch (e) {
    // Without OAuth credentials we cannot sign anyone in. Send to Sentry as a
    // fatal so it's loud, then re-throw so Auth.js produces a meaningful 5xx
    // instead of the opaque OAuthCallbackError seen when client_id="" hits GH.
    logger.fatal(
      { err: e },
      "auth: OAuth client credentials could not be resolved",
    );
    throw e;
  }
  const clientId = authGhId || appClientId || "";
  const clientSecret = authGhSecret || appClientSecret || "";

  if (!clientId || !clientSecret) {
    const err = new Error(
      "GitHub OAuth client_id/client_secret not configured (env or Vault). Sign-in will fail with OAuthCallbackError.",
    );
    logger.fatal(
      {
        err,
        "auth.has_client_id": !!clientId,
        "auth.has_client_secret": !!clientSecret,
      },
      "auth: missing OAuth credentials",
    );
  }

  return {
    ...authConfig,
    // Pipe Auth.js's own logger into Sentry. Auth.js emits the underlying
    // OAuth provider error (token-exchange failure, profile fetch failure,
    // state mismatch, …) here before wrapping it in OAuthCallbackError, so
    // this is the only place we can capture the real cause.
    logger: {
      error(error) {
        const err =
          error instanceof Error ? error : new Error(String(error));
        Sentry.captureException(err, {
          level: "error",
          tags: { component: "auth.js" },
          extra: { name: err.name },
        });
        logger.error({ err }, `auth.js: ${err.name ?? "error"}`);
      },
      warn(code) {
        logger.warn({ "authjs.code": code }, `auth.js warn: ${code}`);
      },
      debug(message, metadata) {
        logger.debug({ "authjs.meta": metadata }, `auth.js debug: ${message}`);
      },
    },
    adapter: PrismaAdapter(prisma),
    providers: [
      GitHub({
        clientId,
        clientSecret,
        profile(profile) {
          return {
            id: String(profile.id),
            name: profile.name ?? profile.login,
            email: profile.email,
            image: profile.avatar_url,
            ghId: profile.id,
            ghLogin: profile.login,
          };
        },
      }),
    ],
    callbacks: {
      async session({ session, user }) {
        try {
          const u = await prisma.user.findUnique({
            where: { id: user.id },
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              ghId: true,
              ghLogin: true,
              isSuperAdmin: true,
              canCreateProj: true,
            },
          });
          if (u) {
            session.user = {
              ...session.user,
              id: u.id,
              name: u.name,
              email: u.email ?? "",
              image: u.image,
              ghId: u.ghId,
              ghLogin: u.ghLogin,
              isSuperAdmin: u.isSuperAdmin,
              canCreateProj: u.canCreateProj,
            };
            Sentry.setUser({
              id: u.id,
              username: u.ghLogin ?? undefined,
              email: u.email ?? undefined,
            });
          }
          return session;
        } catch (e) {
          logger.error(
            { err: e, "auth.user_id": user?.id },
            "auth: session callback failed",
          );
          return session;
        }
      },
    },
    events: {
      async signIn({ user, account, profile, isNewUser }) {
        Sentry.metrics.count("auth.signin", 1, {
          attributes: {
            provider: account?.provider ?? "unknown",
            "auth.is_new_user": Boolean(isNewUser),
          },
        });

        if (account?.provider !== "github" || !profile) return;
        const ghId =
          typeof profile.id === "number" ? profile.id : Number(profile.id);
        const ghLogin = String((profile as { login?: string }).login ?? "");
        if (!ghLogin || !Number.isFinite(ghId)) {
          logger.warn(
            { "auth.user_id": user?.id, "github.login": ghLogin, "github.id": ghId },
            "auth: signin profile missing ghId or ghLogin",
          );
          return;
        }

        const lowerLogin = ghLogin.toLowerCase();
        const shouldBeSuper = env.superAdmins.includes(lowerLogin);
        const shouldBeCreator =
          shouldBeSuper || env.projectCreators.includes(lowerLogin);

        try {
          await prisma.user.update({
            where: { id: user.id! },
            data: {
              ghId,
              ghLogin,
              ...(shouldBeSuper ? { isSuperAdmin: true } : {}),
              ...(shouldBeCreator ? { canCreateProj: true } : {}),
            },
          });
        } catch (e) {
          // Most likely a P2002 unique-violation on ghId/ghLogin (same GH
          // identity already attached to another User row). Surface to Sentry
          // — this is exactly the kind of OAuthCallbackError trigger that's
          // hard to diagnose without a captured exception.
          logger.error(
            {
              err: e,
              "auth.user_id": user?.id,
              "github.login": ghLogin,
              "github.id": ghId,
            },
            "auth: signin event prisma update failed",
          );
        }
      },
      async signOut() {
        Sentry.metrics.count("auth.signout", 1);
      },
    },
  };
});
