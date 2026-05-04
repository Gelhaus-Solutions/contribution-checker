import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true;
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true;
    const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (v4mapped) return isPrivateIp(v4mapped[1]);
    return false;
  }
  return true;
}

export async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeOutboundUrlError(
      `URL scheme not allowed: ${url.protocol}`
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeOutboundUrlError("URL host is empty");

  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new UnsafeOutboundUrlError(
        `URL resolves to a non-public address: ${host}`
      );
    }
    return;
  }

  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new UnsafeOutboundUrlError(
      `URL host not allowed: ${host}`
    );
  }

  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new UnsafeOutboundUrlError(`Could not resolve host: ${host}`);
  }
  if (addrs.length === 0) {
    throw new UnsafeOutboundUrlError(`Could not resolve host: ${host}`);
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new UnsafeOutboundUrlError(
        `URL resolves to a non-public address: ${host} → ${a.address}`
      );
    }
  }
}
