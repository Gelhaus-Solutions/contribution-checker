import { describe, expect, it, vi } from "vitest";
import {
  encryptPlaintextCredentials,
  type CredentialDelegate,
} from "../../prisma/encrypt-credentials-core";

type Row = { id: string } & Record<string, string | null>;

function table(rows: Row[]): CredentialDelegate & { rows: Row[] } {
  return {
    rows,
    async findMany({ where, take }) {
      return rows
        .filter((r) => (where ? r.id > where.id.gt : true))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, take)
        .map((r) => ({ ...r }));
    },
    async updateMany({ where, data }) {
      const { id, ...conds } = where;
      const row = rows.find((r) => r.id === id);
      if (!row || Object.entries(conds).some(([k, v]) => row[k] !== v)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
}

const fakeTransit = vi.fn(async (ps: string[]) => ps.map((p) => `vault:v1:${p}`));

function fixture() {
  const links = table([
    { id: "l1", token: "tok1", apiKey: "key1" },
    { id: "l2", token: "vault:v1:already", apiKey: null },
    { id: "l3", token: "tok3", apiKey: "" },
  ]);
  const hooks = table([
    { id: "h1", secret: "sec1" },
    { id: "h2", secret: null },
  ]);
  return { links, hooks, db: { qaBoardLink: links, projectWebhook: hooks } };
}

describe("db:encrypt-credentials", () => {
  it("encrypts only plaintext values, in every credential column", async () => {
    fakeTransit.mockClear();
    const { links, hooks, db } = fixture();

    const summary = await encryptPlaintextCredentials({
      db, encryptBatch: fakeTransit, dryRun: false, batchSize: 2,
    });

    expect(summary).toEqual({ scanned: 5, alreadyEncrypted: 1, encrypted: 4, raced: 0 });
    expect(links.rows[0]).toMatchObject({ token: "vault:v1:tok1", apiKey: "vault:v1:key1" });
    expect(links.rows[1]!.token).toBe("vault:v1:already"); // untouched, not double-wrapped
    expect(links.rows[2]).toMatchObject({ token: "vault:v1:tok3", apiKey: "" }); // empty stays empty
    expect(hooks.rows[0]!.secret).toBe("vault:v1:sec1");
    expect(hooks.rows[1]!.secret).toBeNull();
  });

  it("is idempotent: a second run changes nothing and never calls Vault", async () => {
    const { db } = fixture();
    await encryptPlaintextCredentials({ db, encryptBatch: fakeTransit, dryRun: false });
    fakeTransit.mockClear();

    const again = await encryptPlaintextCredentials({ db, encryptBatch: fakeTransit, dryRun: false });

    expect(again.encrypted).toBe(0);
    expect(fakeTransit).not.toHaveBeenCalled();
  });

  it("writes nothing and never calls Vault in a dry run", async () => {
    fakeTransit.mockClear();
    const { links, db } = fixture();

    const summary = await encryptPlaintextCredentials({ db, encryptBatch: fakeTransit, dryRun: true });

    expect(summary.encrypted).toBe(4);
    expect(links.rows[0]!.token).toBe("tok1");
    expect(fakeTransit).not.toHaveBeenCalled();
  });

  it("does not overwrite a value a person saved while the run was in flight", async () => {
    const { links, db } = fixture();
    const racing = vi.fn(async (ps: string[]) => {
      links.rows[0]!.token = "tok1-edited"; // saved between read and write
      return ps.map((p) => `vault:v1:${p}`);
    });

    const summary = await encryptPlaintextCredentials({ db, encryptBatch: racing, dryRun: false });

    expect(summary.raced).toBeGreaterThanOrEqual(1);
    expect(links.rows[0]!.token).toBe("tok1-edited");
  });
});

describe("the Transit derivation context", () => {
  it("is the same in the app and in the script, or the script writes what the app cannot read", async () => {
    const { TRANSIT_CONTEXT: script } = await import("../../prisma/encrypt-credentials-core");
    const { TRANSIT_CONTEXT: app } = await import("../../src/lib/vault/client");
    expect(script).toBe(app);
  });
});
