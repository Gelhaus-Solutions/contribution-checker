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
      // Hexclave test config (project id must be a UUID for the SDK).
      STACK_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
      STACK_PUBLISHABLE_CLIENT_KEY: "pck_test",
      STACK_SECRET_SERVER_KEY: "ssk_test",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
