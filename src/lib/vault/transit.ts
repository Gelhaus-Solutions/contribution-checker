import { getVaultClient } from "./resolver";
import { vaultEnabled } from "./config";

/**
 * Encryption at rest for credentials kept in Postgres, with HashiCorp Vault
 * Transit. Covers QaBoardLink.token, QaBoardLink.apiKey and
 * ProjectWebhook.secret.
 *
 * Stored shape: Vault's own envelope, `vault:v<N>:<base64>`, verbatim. N is the
 * Transit key version and moves when the key is rotated, so the prefix test
 * must not pin v1. Decrypt works on any version Vault still holds.
 *
 * Three states of a stored value, and what each does:
 *  - `vault:v<N>:...`  decrypted on read through Transit.
 *  - anything else     a legacy plaintext row. Returned as is, so a deploy
 *                      never breaks a link that was saved before this existed.
 *                      It is encrypted the next time it is written, or by
 *                      `pnpm db:encrypt-credentials`.
 *  - null / empty      stays null / empty (a cleared secret is not encrypted).
 *
 * Writes fail closed: with Vault configured, a failed encrypt throws and
 * nothing is stored, rather than quietly writing plaintext. With Vault NOT
 * configured (a self-hosted install without it) values are stored as before,
 * and reading a `vault:v<N>:` value there throws, because the key is gone.
 *
 * Callers decrypt only where the value is used: inside the QA sync activity,
 * the outbound webhook delivery activity and the board callback route. A
 * decrypted value is never passed to a Temporal workflow or activity argument
 * (so it never lands in history) and never to a client component.
 */

const TRANSIT_RE = /^vault:v\d+:/;

export function isTransitCiphertext(value: string): boolean {
  return TRANSIT_RE.test(value);
}

export class CredentialCryptoError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

/**
 * Encrypt a credential for storage. Always encrypts what it is given, even a
 * value that happens to look like a ciphertext: the input here is what a person
 * typed, not what the database held. Null and empty pass through.
 */
export async function encryptCredential(
  plaintext: string | null | undefined
): Promise<string | null> {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return plaintext === "" ? "" : null;
  }
  if (!vaultEnabled()) return plaintext;
  try {
    return await getVaultClient().transitEncrypt(plaintext);
  } catch (e) {
    throw new CredentialCryptoError(
      "Could not encrypt the credential with Vault Transit; nothing was saved.",
      e
    );
  }
}

/** Decrypt a stored credential; a legacy plaintext value is returned as is. */
export async function decryptCredential(
  stored: string | null | undefined
): Promise<string | null> {
  const [value] = await decryptCredentials([stored]);
  return value ?? null;
}

/** Decrypt several stored credentials with one Vault request. Order kept. */
export async function decryptCredentials(
  stored: (string | null | undefined)[]
): Promise<(string | null)[]> {
  const out: (string | null)[] = stored.map((v) =>
    v === null || v === undefined ? null : v
  );
  const idx: number[] = [];
  const cts: string[] = [];
  out.forEach((v, i) => {
    if (v !== null && isTransitCiphertext(v)) {
      idx.push(i);
      cts.push(v);
    }
  });
  if (cts.length === 0) return out;
  if (!vaultEnabled()) {
    throw new CredentialCryptoError(
      "A stored credential is encrypted with Vault Transit, but Vault is not configured (VAULT_ADDR is unset)."
    );
  }
  try {
    const plain = await getVaultClient().transitDecryptBatch(cts);
    idx.forEach((slot, n) => {
      out[slot] = plain[n] as string;
    });
  } catch (e) {
    throw new CredentialCryptoError(
      "Could not decrypt a stored credential with Vault Transit.",
      e
    );
  }
  return out;
}
