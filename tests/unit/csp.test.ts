import { describe, expect, it, afterEach } from "vitest";
import { buildCsp, reportToHeader } from "@/lib/security/csp";

const origStack = process.env.STACK_API_URL;
const origReport = process.env.SENTRY_CSP_ENDPOINT;
<<<<<<< HEAD
const origExtra = process.env.CSP_EXTRA_DOMAINS;
=======
const CSP_ENV_VARS = [
  "CSP_CONNECT_SRC",
  "CSP_IMG_SRC",
  "CSP_SCRIPT_SRC",
  "CSP_FRAME_SRC",
] as const;
const origExtra = Object.fromEntries(
  CSP_ENV_VARS.map((k) => [k, process.env[k]]),
);
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690

afterEach(() => {
  process.env.STACK_API_URL = origStack;
  process.env.SENTRY_CSP_ENDPOINT = origReport;
<<<<<<< HEAD
  if (origExtra === undefined) delete process.env.CSP_EXTRA_DOMAINS;
  else process.env.CSP_EXTRA_DOMAINS = origExtra;
=======
  for (const k of CSP_ENV_VARS) {
    if (origExtra[k] === undefined) delete process.env[k];
    else process.env[k] = origExtra[k];
  }
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
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

  it("allows data:/blob: in connect-src (Hexclave fetch()es data: avatars)", () => {
    const csp = buildCsp();
    const connect = csp
      .split("; ")
      .find((d) => d.startsWith("connect-src "))!;
    expect(connect).toContain(" data:");
    expect(connect).toContain(" blob:");
  });

<<<<<<< HEAD
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
=======
  it("appends operator-configured extra origins per directive", () => {
    process.env.CSP_CONNECT_SRC = "https://*.mycdn.com https://api.foo.com";
    process.env.CSP_IMG_SRC = "https://images.foo.com";
    const csp = buildCsp();
    expect(csp).toContain("https://*.mycdn.com");
    expect(csp).toContain("https://api.foo.com");
    const img = csp.split("; ").find((d) => d.startsWith("img-src "))!;
    expect(img).toContain("https://images.foo.com");
    // extras land in their own directive, not leaked into connect-src
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src "))!;
    expect(connect).not.toContain("https://images.foo.com");
>>>>>>> e9d924c189c383b3de1708733583aa37c1fb2690
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
