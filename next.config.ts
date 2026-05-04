import type { NextConfig } from "next";
import { createHash } from "node:crypto";

// Pin the Server Actions encryption key to a deterministic value derived from
// AUTH_SECRET. Without this, every restart/rebuild rotates action IDs and any
// user mid-submission gets "Failed to find Server Action", losing their form
// answers. AUTH_SECRET is already required and stable, so we reuse it.
if (!process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY && process.env.AUTH_SECRET) {
  process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = createHash("sha256")
    .update(`contribution-checker:server-actions:${process.env.AUTH_SECRET}`)
    .digest("base64");
}

const config: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
};

export default config;
