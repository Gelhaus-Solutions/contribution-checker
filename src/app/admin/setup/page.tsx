import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { env } from "@/lib/env";
import { getAppSlug } from "@/lib/github/app";

// Public on purpose: the URLs aren't sensitive, and operators need to see
// them BEFORE sign-in is configured (chicken-and-egg in single-App mode).
export default async function GitHubAppSetup() {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const slug = env.githubAppConfigured ? await getAppSlug() : null;
  const webhookUrl = `${base}/api/github/webhook`;
  const oauthCallbackUrl = `${base}/api/auth/callback/github`;
  const homepageUrl = base;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-2xl font-semibold">GitHub App setup</h1>
          <p className="text-sm text-muted-foreground">
            Manual setup — one App handles both sign-in (user-to-server OAuth)
            and repo automation (installation tokens).
          </p>
          {slug && (
            <div className="mt-3 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
              <Badge variant="success" className="mr-2">
                Configured
              </Badge>
              <code>{slug}</code>
            </div>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">URLs for your App</CardTitle>
            <CardDescription>
              Paste these into the corresponding fields when creating the App.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Field label="Homepage URL" value={homepageUrl} />
            <Field label="Webhook URL" value={webhookUrl} />
            <Field
              label="Callback URL"
              value={oauthCallbackUrl}
              hint="Goes in the App's OAuth callback URLs section."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step-by-step</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ol className="list-decimal space-y-3 pl-5">
              <li>
                Go to{" "}
                <a
                  className="underline"
                  href="https://github.com/settings/apps/new"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/settings/apps/new
                </a>{" "}
                (or your org&apos;s App page).
              </li>
              <li>Set the three URLs from the panel above.</li>
              <li>
                Generate a <strong>webhook secret</strong> (any random string;{" "}
                <code>openssl rand -hex 32</code>) and set it. You&apos;ll paste
                it into <code>GITHUB_APP_WEBHOOK_SECRET</code>.
              </li>
              <li>
                Set <strong>repository permissions</strong>:
                <ul className="ml-4 list-disc">
                  <li>Pull requests — <strong>Read &amp; write</strong></li>
                  <li>Issues — <strong>Read &amp; write</strong></li>
                  <li>Checks — <strong>Read &amp; write</strong></li>
                  <li>Contents — Read (needed for PR Quality scoring &mdash; reads PR file diffs)</li>
                  <li>Metadata — Read (auto-selected)</li>
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Existing installations need to accept the new permissions:
                  GitHub will surface a banner in the App&apos;s settings page
                  for every installation owner. Until accepted, status checks
                  and quality scoring silently no-op for that installation.
                </p>
                And <strong>account permissions</strong>:
                <ul className="ml-4 list-disc">
                  <li>Email addresses — Read</li>
                </ul>
                Optional <strong>organization permissions</strong>:
                <ul className="ml-4 list-disc">
                  <li>Members — Read (only needed if you&apos;ll use the
                    auto-bypass-collaborators feature for org repos)
                  </li>
                </ul>
              </li>
              <li>
                Subscribe to events:{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  Pull request
                </code>{" "}
                (with the <code>synchronize</code> action enabled so we
                re-evaluate on push),{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  Installation target
                </code>{" "}
                (also called Installation), and{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  Installation repositories
                </code>
                .
              </li>
              <li>
                Under &ldquo;Where can this GitHub App be installed?&rdquo;,
                pick <strong>Only on this account</strong> for a private
                instance, or <strong>Any account</strong> if you&apos;re
                running a multi-tenant deployment.
              </li>
              <li>Click <strong>Create GitHub App</strong>.</li>
              <li>
                On the App page, scroll to <strong>Private keys</strong> →{" "}
                <strong>Generate a private key</strong>. A <code>.pem</code>{" "}
                file downloads.
              </li>
              <li>
                Note the <strong>App ID</strong>, <strong>Client ID</strong>,
                and click <strong>Generate a new client secret</strong> to get
                the <strong>Client secret</strong>.
              </li>
              <li>
                Fill in your <code>.env</code>:
                <pre className="mt-2 overflow-x-auto rounded bg-muted px-3 py-2 text-xs">{`GITHUB_APP_ID="<the App ID>"
GITHUB_APP_SLUG="<the slug — last segment of the app's URL>"
GITHUB_APP_CLIENT_ID="<Client ID>"
GITHUB_APP_CLIENT_SECRET="<Client secret>"
GITHUB_APP_WEBHOOK_SECRET="<the random secret you generated>"
# PEM with literal \\n between lines, all on one line, in double quotes:
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"

# Single-App mode: leave AUTH_GITHUB_ID/SECRET blank — the App's
# Client ID/Secret are reused for sign-in.`}</pre>
              </li>
              <li>
                Restart the server. Confirm this page shows the green
                &ldquo;Configured&rdquo; badge above.
              </li>
              <li>
                Install the App on a repo (App page → <strong>Install App</strong>),
                then link it from a project&apos;s <strong>Repos</strong> tab.
              </li>
            </ol>
          </CardContent>
        </Card>
      </main>
    </>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="grid grid-cols-[160px_1fr] items-center gap-2">
        <span className="text-muted-foreground">{label}</span>
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
          {value}
        </code>
      </div>
      {hint && (
        <p className="ml-[164px] mt-1 text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
