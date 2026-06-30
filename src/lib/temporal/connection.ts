import { readFile } from "node:fs/promises";
import { env } from "@/lib/env";
import { getSecret } from "@/lib/vault/resolver";
import { logger } from "@/lib/logger";

/**
 * Build the gRPC target address from env. Worker and client share it.
 */
export function temporalAddress(): string {
  return `${env.TEMPORAL_HOST}:${env.TEMPORAL_PORT}`;
}

export type ResolvedTls = {
  clientCertPair: { crt: Buffer; key: Buffer };
  serverRootCACertificate?: Buffer;
  serverNameOverride?: string;
};

/**
 * A TLS env/Vault value may be EITHER an absolute filesystem path to a PEM file
 * (when certs are mounted into the container) OR the PEM text itself (when
 * stored in Vault or inlined in env). We detect a path by a leading "/" without
 * a PEM header, read the file, and otherwise treat the value as PEM bytes.
 */
async function resolvePem(value: string): Promise<Buffer> {
  const looksLikePem = value.includes("-----BEGIN");
  if (!looksLikePem && value.startsWith("/")) {
    return readFile(value.trim());
  }
  return Buffer.from(value);
}

/**
 * Resolve the mTLS material when TEMPORAL_TLS_ENABLED is true, else null.
 * Cert/key/CA come from Vault or env via getSecret, consistent with the GitHub
 * App key and SMTP creds. Each value may be a mounted PEM file path or inline
 * PEM text (see resolvePem). Resolved bytes are kept in memory.
 *
 * Throws when TLS is enabled but the client cert or key is missing — failing
 * closed is correct: a worker that silently connects without mTLS to a cluster
 * that requires it would just spin on auth errors.
 */
export async function resolveTemporalTls(): Promise<ResolvedTls | null> {
  if (!env.TEMPORAL_TLS_ENABLED) return null;

  const [cert, key, ca] = await Promise.all([
    getSecret("TEMPORAL_TLS_CERT"),
    getSecret("TEMPORAL_TLS_KEY"),
    getSecret("TEMPORAL_TLS_CA"),
  ]);

  if (!cert || !key) {
    throw new Error(
      "TEMPORAL_TLS_ENABLED=true but TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY " +
        "could not be resolved (env or Vault). Refusing to connect without mTLS."
    );
  }

  const [crt, keyBuf, caBuf] = await Promise.all([
    resolvePem(cert),
    resolvePem(key),
    ca ? resolvePem(ca) : Promise.resolve(undefined),
  ]);

  return {
    clientCertPair: { crt, key: keyBuf },
    serverRootCACertificate: caBuf,
    serverNameOverride: env.TEMPORAL_TLS_SERVER_NAME || undefined,
  };
}

/**
 * Connection options for the `@temporalio/client` Connection (used by the
 * Next.js app to start/signal workflows). The TLS shape matches
 * client.ConnectionOptions.tls.
 */
export async function clientConnectionOptions(): Promise<{
  address: string;
  tls?: {
    clientCertPair: { crt: Buffer; key: Buffer };
    serverRootCACertificate?: Buffer;
    serverNameOverride?: string;
  };
}> {
  const address = temporalAddress();
  const tls = await resolveTemporalTls();
  if (!tls) {
    logger.debug({ address }, "temporal client connecting without TLS");
    return { address };
  }
  logger.debug({ address }, "temporal client connecting with mTLS");
  return { address, tls };
}
