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
import { SubmitButton } from "@/components/ui/submit-button";
import { env } from "@/lib/env";
import { getAppSlug } from "@/lib/github/app";
import { PageHeader } from "@/components/page-header";
import { provisionStackAuthAction } from "./actions";

export default async function AdminHome() {
  await requireSuperAdmin();
  const slug = env.githubAppConfigured ? await getAppSlug() : null;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <PageHeader
          title="Super-admin"
          description="Instance-wide settings and integration status."
        />

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
            {slug ? (
              <p className="text-sm text-muted-foreground">
                Configured: <code>{slug}</code>
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stack Auth permissions</CardTitle>
            <CardDescription>
              Reconcile the project permission hierarchy and seed the Instance
              Admin team. Idempotent; re-run after changing the permission
              catalog. Requires the super-secret admin key.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {env.stackAdminConfigured ? (
              <form action={provisionStackAuthAction}>
                <SubmitButton size="sm">Provision permissions</SubmitButton>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                Set <code>STACK_SUPER_SECRET_ADMIN_KEY</code> to enable
                provisioning.
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
