import { defineConfig, devices } from "@playwright/test";

/**
 * There were no UI tests and no config at all, despite a `test:e2e` script.
 * This is a smoke suite, not coverage: its job is to catch a design-token or
 * layout regression that typecheck and the unit tests cannot see.
 *
 * Runs against `next dev` on a spare port so it does not fight a dev server
 * you already have open.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `pnpm next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
