import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  callbacks: {
    ...authConfig.callbacks,
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
      const ghId = typeof profile.id === "number" ? profile.id : Number(profile.id);
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
});
