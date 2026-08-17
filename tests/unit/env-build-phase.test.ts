import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the container build.
 *
 * The image is built generic, with no .env and no environment variables, so
 * `schema.safeParse(process.env)` fails and env.ts takes its build-phase
 * fallback path. That path used `schema.partial()`, which wraps every field in
 * ZodOptional; ZodOptional short-circuits on a missing key and therefore never
 * reaches that field's `.default()`. The result was
 * `env.PUBLIC_BASE_URL === undefined`, which crashed `next build` while
 * prerendering /sitemap.xml with "Cannot read properties of undefined
 * (reading 'replace')".
 *
 * It was invisible locally because a .env file makes the strict parse succeed.
 */
describe("env under the production build phase", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    vi.resetModules();
    // A bare environment, as inside the Docker build stage. Cast through
    // unknown because NodeJS.ProcessEnv declares NODE_ENV as required, and the
    // whole point here is that it is absent.
    process.env = {
      NEXT_PHASE: "phase-production-build",
    } as unknown as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = ORIGINAL;
    vi.resetModules();
  });

  it("still applies schema defaults when nothing is set", async () => {
    const { env } = await import("@/lib/env");

    expect(env.PUBLIC_BASE_URL).toBe("http://localhost:3000");
    // Anything that reads it does `.replace(/\/$/, "")` on it.
    expect(() => env.PUBLIC_BASE_URL.replace(/\/$/, "")).not.toThrow();
  });

  it("keeps the other defaulted fields defined too", async () => {
    const { env } = await import("@/lib/env");

    expect(env.GITHUB_APP_SLUG).toBe("contribution-checker");
    expect(env.NODE_ENV).toBeDefined();
  });

  it("does not invent credentials", async () => {
    const { env } = await import("@/lib/env");

    // The placeholder exists only to let the full schema run; nothing should
    // read it as a real connection string, and no secret should look present.
    expect(env.githubAppConfigured).toBe(false);
    expect(env.stackConfigured).toBe(false);
  });

  it("prefers a real value over the default when one is set", async () => {
    process.env.PUBLIC_BASE_URL = "https://checker.example.com";
    const { env } = await import("@/lib/env");

    expect(env.PUBLIC_BASE_URL).toBe("https://checker.example.com");
  });
});
