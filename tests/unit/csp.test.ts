import { describe, expect, it, afterEach } from "vitest";
import { buildCsp, reportToHeader } from "@/lib/security/csp";

const origReport = process.env.SENTRY_CSP_ENDPOINT;
const origExtra = process.env.CSP_EXTRA_DOMAINS;
const origGpid = process.env.GPID_URL;

afterEach(() => {
  process.env.SENTRY_CSP_ENDPOINT = origReport;
  if (origExtra === undefined) delete process.env.CSP_EXTRA_DOMAINS;
  else process.env.CSP_EXTRA_DOMAINS = origExtra;
  if (origGpid === undefined) delete process.env.GPID_URL;
  else process.env.GPID_URL = origGpid;
});

describe("buildCsp", () => {
  it("always allows self + Sentry ingest in connect-src", () => {
    const csp = buildCsp();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("https://*.ingest.sentry.io");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("names no sign-in backend or Stripe: the browser never talks to either", () => {
    process.env.STACK_API_URL = "https://auth.egelhaus.de";
    const csp = buildCsp();
    expect(csp).not.toContain("auth.egelhaus.de");
    expect(csp).not.toContain("stripe.com");
    delete process.env.STACK_API_URL;
  });

  it("allows data:/blob: in connect-src", () => {
    const csp = buildCsp();
    const connect = csp
      .split("; ")
      .find((d) => d.startsWith("connect-src "))!;
    expect(connect).toContain(" data:");
    expect(connect).toContain(" blob:");
  });

  it("allows GPlatform Identity's ORIGIN for images only, where GPID_URL is set", () => {
    process.env.GPID_URL = "https://identity.example.test/some/path";
    const directive = (name: string) =>
      buildCsp()
        .split("; ")
        .find((d) => d.startsWith(`${name} `))!;
    expect(directive("img-src")).toContain(" https://identity.example.test ");
    expect(directive("img-src")).not.toContain("/some/path");
    expect(directive("connect-src")).not.toContain("identity.example.test");
    expect(directive("script-src")).not.toContain("identity.example.test");

    delete process.env.GPID_URL;
    expect(directive("img-src")).not.toContain("identity.example.test");
  });

  it("appends CSP_EXTRA_DOMAINS to the resource directives", () => {
    process.env.CSP_EXTRA_DOMAINS = "https://*.mycdn.com, https://api.foo.com";
    const csp = buildCsp();
    for (const dir of ["connect-src", "img-src", "script-src", "frame-src"]) {
      const d = csp.split("; ").find((x) => x.startsWith(`${dir} `))!;
      expect(d).toContain("https://*.mycdn.com");
      expect(d).toContain("https://api.foo.com");
    }
    // restrictive directives are untouched
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
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
