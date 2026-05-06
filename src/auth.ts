import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
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
  const [authGhId, authGhSecret, appClientId, appClientSecret] =
    await Promise.all([
      getSecret("AUTH_GITHUB_ID"),
      getSecret("AUTH_GITHUB_SECRET"),
      getSecret("GITHUB_APP_CLIENT_ID"),
      getSecret("GITHUB_APP_CLIENT_SECRET"),
    ]);
  const clientId = authGhId || appClientId || "";
  const clientSecret = authGhSecret || appClientSecret || "";

  return {
    ...authConfig,
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
        }
        return session;
      },
    },
    events: {
      async signIn({ user, account, profile }) {
        if (account?.provider !== "github" || !profile) return;
        const ghId =
          typeof profile.id === "number" ? profile.id : Number(profile.id);
        const ghLogin = String((profile as { login?: string }).login ?? "");
        if (!ghLogin || !Number.isFinite(ghId)) return;

        const lowerLogin = ghLogin.toLowerCase();
        const shouldBeSuper = env.superAdmins.includes(lowerLogin);
        const shouldBeCreator =
          shouldBeSuper || env.projectCreators.includes(lowerLogin);

        await prisma.user.update({
          where: { id: user.id! },
          data: {
            ghId,
            ghLogin,
            ...(shouldBeSuper ? { isSuperAdmin: true } : {}),
            ...(shouldBeCreator ? { canCreateProj: true } : {}),
          },
        });
      },
    },
  };
});
