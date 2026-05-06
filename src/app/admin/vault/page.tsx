import { SiteHeader } from "@/components/site-header";
import { requireSuperAdmin } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { env } from "@/lib/env";
import { getVaultPathFor } from "@/lib/vault/config";
import {
  KNOWN_SECRET_NAMES,
  getSecret,
  VaultResolutionError,
} from "@/lib/vault/resolver";
import { getSecretStatus } from "@/lib/vault/status";

export const dynamic = "force-dynamic";

type Row = {
  name: string;
  pathConfigured: boolean;
  pathSpec: string | null;
  source: "vault" | "env" | "missing" | "error";
  error: string | null;
  cacheHits: number;
  lastResolvedAt: Date | null;
};

async function probeSecret(name: string): Promise<Row> {
  const pathSpec = getVaultPathFor(name);
  const pathConfigured = !!pathSpec;
  try {
    const value = await getSecret(name);
    const status = getSecretStatus(name);
    if (!value) {
      return {
        name,
        pathConfigured,
        pathSpec,
        source: "missing",
        error: status?.lastError ?? null,
        cacheHits: status?.cacheHits ?? 0,
        lastResolvedAt: status?.lastResolvedAt ?? null,
      };
    }
    return {
      name,
      pathConfigured,
      pathSpec,
      source: status?.lastSource ?? (pathConfigured ? "vault" : "env"),
      error: null,
      cacheHits: status?.cacheHits ?? 0,
      lastResolvedAt: status?.lastResolvedAt ?? null,
    };
  } catch (e) {
    const status = getSecretStatus(name);
    return {
      name,
      pathConfigured,
      pathSpec,
      source: "error",
      error:
        e instanceof VaultResolutionError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      cacheHits: status?.cacheHits ?? 0,
      lastResolvedAt: status?.lastResolvedAt ?? null,
    };
  }
}

export default async function VaultStatusPage() {
  await requireSuperAdmin();

  const rows = await Promise.all(KNOWN_SECRET_NAMES.map(probeSecret));

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-2xl font-semibold">HashiCorp Vault</h1>
          <p className="text-sm text-muted-foreground">
            Per-secret resolution status. No secret values are displayed.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connection</CardTitle>
            <CardDescription>
              Auth credentials are kept out of this page on purpose.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Field label="Enabled">
              {env.vaultEnabled ? (
                <Badge variant="success">Yes</Badge>
              ) : (
                <Badge variant="secondary">No</Badge>
              )}
            </Field>
            <Field label="Address">
              <code className="text-xs">{env.VAULT_ADDR ?? "(unset)"}</code>
            </Field>
            <Field label="Auth method">
              <code className="text-xs">{env.VAULT_AUTH_METHOD ?? "(default: token)"}</code>
            </Field>
            <Field label="Namespace">
              <code className="text-xs">{env.VAULT_NAMESPACE ?? "(none)"}</code>
            </Field>
            <Field label="Cache TTL">
              <code className="text-xs">{env.VAULT_CACHE_TTL_SECONDS ?? 300}s</code>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Secrets</CardTitle>
            <CardDescription>
              Each secret resolves from Vault when{" "}
              <code className="text-xs">VAULT_&lt;NAME&gt;_PATH</code> is set;
              otherwise it falls back to the env var of the same name.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-2 text-sm">
              <div className="text-xs font-medium text-muted-foreground">Name / path</div>
              <div className="text-xs font-medium text-muted-foreground">Source</div>
              <div className="text-xs font-medium text-muted-foreground">Cache hits</div>
              {rows.map((r) => (
                <Row key={r.name} row={r} />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Env example</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded bg-muted px-3 py-2 text-xs">{`# Vault connection
VAULT_ADDR="https://vault.example.com"
VAULT_AUTH_METHOD="approle"           # or "token"
VAULT_APPROLE_ROLE_ID="..."
VAULT_APPROLE_SECRET_ID="..."
# VAULT_TOKEN="..."                   # only when VAULT_AUTH_METHOD=token
# VAULT_NAMESPACE="..."               # Vault Enterprise only
VAULT_CACHE_TTL_SECONDS="300"

# Per-secret paths (KV v2). Format: "<full-path>[#<field>]"
# Without #field, the resolver looks for a key named "value".
VAULT_GITHUB_APP_ID_PATH="secret/data/cc/github#app_id"
VAULT_GITHUB_APP_PRIVATE_KEY_PATH="secret/data/cc/github#private_key"
VAULT_GITHUB_APP_WEBHOOK_SECRET_PATH="secret/data/cc/github#webhook_secret"
VAULT_GITHUB_APP_CLIENT_ID_PATH="secret/data/cc/github#client_id"
VAULT_GITHUB_APP_CLIENT_SECRET_PATH="secret/data/cc/github#client_secret"
VAULT_SMTP_USER_PATH="secret/data/cc/smtp#user"
VAULT_SMTP_PASS_PATH="secret/data/cc/smtp#password"
`}</pre>
          </CardContent>
        </Card>
      </main>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function Row({ row }: { row: Row }) {
  const sourceBadge = (() => {
    switch (row.source) {
      case "vault":
        return <Badge variant="success">Vault</Badge>;
      case "env":
        return <Badge variant="secondary">env</Badge>;
      case "missing":
        return <Badge variant="outline">missing</Badge>;
      case "error":
        return <Badge variant="destructive">error</Badge>;
    }
  })();
  return (
    <>
      <div className="min-w-0">
        <div className="font-mono text-xs">{row.name}</div>
        {row.pathSpec && (
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {row.pathSpec}
          </div>
        )}
        {row.error && (
          <div className="mt-1 text-[11px] text-destructive">{row.error}</div>
        )}
      </div>
      <div>{sourceBadge}</div>
      <div className="text-right text-xs tabular-nums text-muted-foreground">
        {row.cacheHits}
      </div>
    </>
  );
}
