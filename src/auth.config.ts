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
  // No `authorized` middleware callback: we use database-backed sessions,
  // which can't be looked up in the edge runtime. Each protected server page
  // calls `requireSession()` itself.
} satisfies NextAuthConfig;
