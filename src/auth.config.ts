import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";

export const authConfig = {
  trustHost: true,
  session: { strategy: "database" },
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID || process.env.GITHUB_APP_CLIENT_ID,
      clientSecret:
        process.env.AUTH_GITHUB_SECRET || process.env.GITHUB_APP_CLIENT_SECRET,
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
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      // /admin/setup is intentionally public so operators can read the
      // webhook + callback URLs before sign-in is configured.
      if (pathname === "/admin/setup" || pathname.startsWith("/admin/setup/")) {
        return true;
      }
      const isProtected =
        pathname.startsWith("/dashboard") || pathname.startsWith("/admin");
      if (!isProtected) return true;
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;
