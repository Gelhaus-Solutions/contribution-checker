import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: {
      DATABASE_URL: "file:./data/test.db",
      PUBLIC_BASE_URL: "http://localhost:3000",
      NODE_ENV: "test",
      // GPID test config, so env.gpidConfigured is true under test.
      GPID_URL: "http://identity.test",
      GPID_APP_SECRET: "gpid_test_secret",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // The Next.js "server-only" guard throws when bundled for the client; it
      // has no meaning under vitest's Node runtime, so stub it to a no-op. This
      // lets tests import server modules (e.g. lib/temporal/start) transitively.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
