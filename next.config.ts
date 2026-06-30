import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { withSentryConfig } from "@sentry/nextjs";

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
  // Keep the Temporal client + its gRPC transport OUT of the Next.js server
  // bundle. @grpc/grpc-js does dynamic requires / proto loading that breaks when
  // webpack-bundled, surfacing as a transport error ("undefined undefined:
  // undefined" on getSystemInfo) the first time a route/action starts a workflow.
  // Externalizing makes Next require them from node_modules at runtime instead.
  serverExternalPackages: [
    "@temporalio/client",
    "@temporalio/common",
    "@temporalio/proto",
    "@grpc/grpc-js",
  ],
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
  async headers() {
    const isHttps = (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://");
    // The Content-Security-Policy is deliberately NOT set here: these header
    // rules are baked into routes-manifest.json at `next build`, but the CSP's
    // connect-src must include the operator's Hexclave backend (STACK_API_URL),
    // which is only known at container runtime in our generic CI image. The CSP
    // (and its Report-To) is therefore set per-request in src/middleware.ts
    // (see src/lib/security/csp.ts). The static headers below are constant and
    // safe to bake.
    return [
      {
        source: "/:path*",
        headers: [
          // Required for Sentry browser profiling.
          { key: "Document-Policy", value: "js-profiling" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          ...(isHttps
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default withSentryConfig(config, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  webpack: {
    treeshake: { removeDebugLogging: true },
    automaticVercelMonitors: false,
  },
});
