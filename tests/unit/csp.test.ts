import { describe, expect, it, afterEach } from "vitest";
import { buildCsp, reportToHeader } from "@/lib/security/csp";

const origStack = process.env.STACK_API_URL;
const origReport = process.env.SENTRY_CSP_ENDPOINT;

afterEach(() => {
  process.env.STACK_API_URL = origStack;
  process.env.SENTRY_CSP_ENDPOINT = origReport;
});

describe("buildCsp", () => {
  it("always allows self + Sentry ingest in connect-src", () => {
    delete process.env.STACK_API_URL;
    const csp = buildCsp();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("https://*.ingest.sentry.io");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("includes the Hexclave backend ORIGIN (not the full URL) when configured", () => {
    process.env.STACK_API_URL = "https://auth.egelhaus.de/some/path";
    const csp = buildCsp();
    expect(csp).toContain("https://auth.egelhaus.de");
    expect(csp).not.toContain("https://auth.egelhaus.de/some/path");
  });

  it("ignores an invalid STACK_API_URL", () => {
    process.env.STACK_API_URL = "not a url";
    expect(buildCsp()).toContain("connect-src 'self'");
  });

  it("adds report-uri/report-to only when the Sentry CSP endpoint is set", () => {
    delete process.env.SENTRY_CSP_ENDPOINT;
    expect(buildCsp()).not.toContain("report-uri");
    expect(reportToHeader()).toBeNull();

    process.env.SENTRY_CSP_ENDPOINT = "https://sentry.example/csp";
    expect(buildCsp()).toContain("report-uri https://sentry.example/csp");
    expect(buildCsp()).toContain("report-to csp-endpoint");
    expect(reportToHeader()).toContain("csp-endpoint");
  });
});
