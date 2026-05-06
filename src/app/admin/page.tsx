import Link from "next/link";
import { requireSuperAdmin } from "@/lib/authz";
import { SiteHeader } from "@/components/site-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/lib/env";

export default async function AdminHome() {
  await requireSuperAdmin();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <h1 className="text-2xl font-semibold">Super-admin</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project creator allowlist</CardTitle>
            <CardDescription>
              Control who can create projects on this instance.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/admin/allowlist"
              className="text-sm font-medium underline underline-offset-2"
            >
              Manage allowlist →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">GitHub App</CardTitle>
            <CardDescription>
              Required for repo automation. Bootstrap once via the manifest flow.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {env.githubAppConfigured ? (
              <p className="text-sm text-muted-foreground">
                Configured: <code>{env.GITHUB_APP_SLUG}</code>
              </p>
            ) : (
              <Link
                href="/admin/setup"
                className="text-sm font-medium underline underline-offset-2"
              >
                Set up GitHub App →
              </Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">HashiCorp Vault</CardTitle>
            <CardDescription>
              Source secrets (GitHub App key, OAuth, SMTP) from Vault instead of env.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/admin/vault"
              className="text-sm font-medium underline underline-offset-2"
            >
              {env.vaultEnabled ? "View Vault status →" : "Configure Vault →"}
            </Link>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
