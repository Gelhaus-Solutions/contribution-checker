/**
 * One-off: encrypt the credential columns that were saved before encryption at
 * rest existed (QaBoardLink.token, QaBoardLink.apiKey, ProjectWebhook.secret)
 * with HashiCorp Vault Transit.
 *
 * New and edited values are encrypted when they are written, and an unencrypted
 * value still reads fine (it is just returned as is), so this is not needed to
 * keep anything working. It is what closes the gap for rows nobody saves again.
 *
 *   pnpm db:encrypt-credentials            # apply
 *   DRY_RUN=1 pnpm db:encrypt-credentials  # count what would change, no writes
 *
 * Idempotent and re-runnable. Needs VAULT_ADDR and either VAULT_TOKEN or
 * VAULT_APPROLE_ROLE_ID + VAULT_APPROLE_SECRET_ID (VAULT_APPROLE_MOUNT, default
 * approle), optionally VAULT_NAMESPACE, and the same VAULT_TRANSIT_MOUNT /
 * VAULT_TRANSIT_KEY the app uses (defaults: transit, contribution-checker). The
 * Vault role needs `update` on transit/encrypt/<key> only.
 */
import { PrismaClient } from "@prisma/client";
import {
  TRANSIT_CONTEXT,
  encryptPlaintextCredentials,
  type EncryptCredentialsDeps,
} from "./encrypt-credentials-core";

const DRY_RUN = process.env.DRY_RUN === "1";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

async function vaultToken(addr: string, ns: string | undefined): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ns) headers["x-vault-namespace"] = ns;
  if (process.env.VAULT_AUTH_METHOD === "approle") {
    const mount = process.env.VAULT_APPROLE_MOUNT ?? "approle";
    const res = await fetch(`${addr}/v1/auth/${mount}/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        role_id: requireEnv("VAULT_APPROLE_ROLE_ID"),
        secret_id: requireEnv("VAULT_APPROLE_SECRET_ID"),
      }),
    });
    if (!res.ok) throw new Error(`Vault AppRole login failed (${res.status}).`);
    const json = (await res.json()) as { auth?: { client_token?: string } };
    if (!json.auth?.client_token) throw new Error("AppRole login returned no token.");
    return json.auth.client_token;
  }
  return requireEnv("VAULT_TOKEN");
}

function transitEncryptBatch(): EncryptCredentialsDeps["encryptBatch"] {
  const addr = requireEnv("VAULT_ADDR").replace(/\/$/, "");
  const ns = process.env.VAULT_NAMESPACE;
  const mount = (process.env.VAULT_TRANSIT_MOUNT ?? "transit").replace(/^\/+|\/+$/g, "");
  const key = process.env.VAULT_TRANSIT_KEY ?? "contribution-checker";
  let token: string | undefined;

  return async (plaintexts) => {
    token ??= await vaultToken(addr, ns);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-vault-token": token,
    };
    if (ns) headers["x-vault-namespace"] = ns;
    const res = await fetch(
      `${addr}/v1/${mount.split("/").map(encodeURIComponent).join("/")}/encrypt/${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          batch_input: plaintexts.map((p) => ({
            plaintext: Buffer.from(p, "utf8").toString("base64"),
            context: TRANSIT_CONTEXT,
          })),
        }),
      },
    );
    // Never print the body: it can echo request fields.
    if (!res.ok) throw new Error(`Vault transit encrypt failed (${res.status}).`);
    const json = (await res.json()) as {
      data?: { batch_results?: { ciphertext?: string }[] };
    };
    const results = json.data?.batch_results;
    if (!results || results.length !== plaintexts.length) {
      throw new Error("Vault transit encrypt returned a malformed batch.");
    }
    return results.map((r) => {
      if (!r.ciphertext) throw new Error("Vault transit encrypt returned no ciphertext.");
      return r.ciphertext;
    });
  };
}

// PrismaClient construction loads .env into process.env, so read Vault env after.
const prisma = new PrismaClient();

async function main() {
  const summary = await encryptPlaintextCredentials({
    db: prisma as unknown as EncryptCredentialsDeps["db"],
    encryptBatch: DRY_RUN ? async () => [] : transitEncryptBatch(),
    dryRun: DRY_RUN,
  });
  console.log("Credential encryption summary:", JSON.stringify(summary, null, 2));
  if (DRY_RUN) console.log("(dry run: no writes performed)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
