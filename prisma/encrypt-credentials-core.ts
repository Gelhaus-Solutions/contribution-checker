/**
 * The logic of `pnpm db:encrypt-credentials`, kept apart from the CLI so a test
 * can drive it with a fake database and a fake Transit.
 *
 * Self-contained on purpose (no `@/` imports): the production image ships the
 * built app and prisma/, not src/, and this runs from there.
 */

const TRANSIT_RE = /^vault:v\d+:/;

export const CREDENTIAL_COLUMNS = [
  { model: "qaBoardLink", fields: ["token", "apiKey"] },
  { model: "projectWebhook", fields: ["secret"] },
] as const;

type Row = { id: string } & Record<string, string | null | undefined>;

export interface CredentialDelegate {
  findMany(args: {
    where?: { id: { gt: string } };
    orderBy: { id: "asc" };
    take: number;
  }): Promise<Row[]>;
  updateMany(args: {
    where: Record<string, string>;
    data: Record<string, string>;
  }): Promise<{ count: number }>;
}

export interface EncryptCredentialsDeps {
  db: Record<(typeof CREDENTIAL_COLUMNS)[number]["model"], CredentialDelegate>;
  /** One Transit encrypt per plaintext, order preserved. */
  encryptBatch(plaintexts: string[]): Promise<string[]>;
  dryRun: boolean;
  batchSize?: number;
}

export interface EncryptCredentialsSummary {
  scanned: number;
  alreadyEncrypted: number;
  encrypted: number;
  /** A row changed between read and write (someone saved it), so it was left. */
  raced: number;
}

/**
 * Encrypt every plaintext credential column. Idempotent: a value that already
 * carries a `vault:v<N>:` prefix is skipped, so a re-run after a partial run, or
 * after rotating the key, touches nothing. Each write is conditional on the
 * column still holding the plaintext that was read, so a concurrent save by a
 * person is never overwritten with an older value.
 */
export async function encryptPlaintextCredentials(
  deps: EncryptCredentialsDeps,
): Promise<EncryptCredentialsSummary> {
  const take = deps.batchSize ?? 100;
  const summary: EncryptCredentialsSummary = {
    scanned: 0,
    alreadyEncrypted: 0,
    encrypted: 0,
    raced: 0,
  };

  for (const { model, fields } of CREDENTIAL_COLUMNS) {
    const delegate = deps.db[model];
    let cursor: string | undefined;
    for (;;) {
      const rows = await delegate.findMany({
        ...(cursor ? { where: { id: { gt: cursor } } } : {}),
        orderBy: { id: "asc" },
        take,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;

      const todo: { id: string; field: string; plaintext: string }[] = [];
      for (const row of rows) {
        for (const field of fields) {
          const value = row[field];
          if (value === null || value === undefined || value === "") continue;
          summary.scanned++;
          if (TRANSIT_RE.test(value)) summary.alreadyEncrypted++;
          else todo.push({ id: row.id, field, plaintext: value });
        }
      }
      if (todo.length === 0) continue;
      if (deps.dryRun) {
        summary.encrypted += todo.length;
        continue;
      }

      const ciphertexts = await deps.encryptBatch(todo.map((t) => t.plaintext));
      for (const [i, t] of todo.entries()) {
        const { count } = await delegate.updateMany({
          where: { id: t.id, [t.field]: t.plaintext },
          data: { [t.field]: ciphertexts[i]! },
        });
        if (count === 1) summary.encrypted++;
        else summary.raced++;
      }
    }
  }
  return summary;
}
