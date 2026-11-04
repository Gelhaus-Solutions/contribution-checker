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
import { CodeBlock } from "@/components/code-block";
import { SHELL_NARROW } from "@/lib/ui/layout";

// Public on purpose: the URLs aren't sensitive, and operators need to see
// them BEFORE sign-in is configured (chicken-and-egg in single-App mode).
export default async function GitHubAppSetup() {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const slug = env.githubAppConfigured ? await getAppSlug() : null;
  const webhookUrl = `${base}/api/github/webhook`;
  // Sign-in is GitHub through GPlatform Identity, whose own GitHub provider
  // owns the OAuth round trip; this app only registers where GPID sends the
  // browser back.
  const signInCallbackUrl = `${base}/auth/callback`;
  const homepageUrl = base;

  return (
    <>
      <SiteHeader />
      <main className={`${SHELL_NARROW} space-y-6 py-10`}>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">GitHub App setup</h1>
          <p className="text-sm text-muted-foreground">
            Manual setup. The GitHub App handles repo automation (installation
            tokens); human sign-in is GitHub through GPlatform Identity (see
            the Identity card below).
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">GPlatform Identity (login) setup</CardTitle>
            <CardDescription>
              Everybody signs in with GitHub through GPlatform Identity (GPID),
              where this app is enrolled as a native product.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ol className="list-decimal space-y-3 pl-5">
              <li>
                On GPID&apos;s host, from <code>sso/</code>, enrol the app and
                register its sign-in callback:
                <CodeBlock className="mt-2" language="sh" code={`node scripts/register-app.mjs native contribution-checker "Contribution Checker"
node scripts/register-app.mjs --redirect contribution-checker ${signInCallbackUrl}`} />
                Keep the secret the first command prints.
              </li>
              <li>
                Fill in your <code>.env</code>:
                <CodeBlock className="mt-2" language=".env" code={`GPID_URL="<GPID's address>"
GPID_APP_SECRET="<the secret the enrolment printed>"   # may live in Vault
GPID_CHROME_TOKEN="<issued for contribution-checker on GPID's product screen>"`} />
              </li>
              <li>
                Moving accounts over from Hexclave: export and import them by
                GPID&apos;s runbook (<code>sso/docs/migration.md</code>), then
                give each account its subject from the map the import printed:{" "}
                <code>DRY_RUN=1 pnpm db:backfill:sso-subjects subjects.json</code>{" "}
                to preview, then without <code>DRY_RUN</code> to write.
              </li>
            </ol>
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
                  <li>Pull requests: <strong>Read &amp; write</strong></li>
                  <li>Issues: <strong>Read &amp; write</strong></li>
                  <li>Checks: <strong>Read &amp; write</strong></li>
                  <li>Contents: Read (needed for PR Quality scoring and for repo-file CLA sources; reads PR file diffs and tracked CLA files)</li>
                  <li>Contents: <strong>Read &amp; write</strong> only if you
                    enable staging routing and want the bot to create a missing
                    staging branch for you. This grants the App the ability to
                    push to every file in every installed repository, so prefer
                    creating the staging branch yourself and leaving Contents at
                    Read. Without write, repos whose staging branch is missing
                    are skipped with a warning; everything else keeps working.
                  </li>
                  <li>Metadata: Read (auto-selected)</li>
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Existing installations need to accept the new permissions:
                  GitHub will surface a banner in the App&apos;s settings page
                  for every installation owner. Until accepted, status checks
                  and quality scoring silently no-op for that installation.
                </p>
                And <strong>account permissions</strong>:
                <ul className="ml-4 list-disc">
                  <li>Email addresses: Read</li>
                </ul>
                Optional <strong>organization permissions</strong>:
                <ul className="ml-4 list-disc">
                  <li>Members: Read (only needed if you&apos;ll use the
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
                  Push
                </code>{" "}
                (so a tracked CLA file change auto-publishes or queues a new
                version, and a direct push to a staging branch refreshes the
                aggregate PR&apos;s description),{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  Installation target
                </code>{" "}
                (also called Installation),{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  Installation repositories
                </code>
                , and{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  Merge group
                </code>
                , and{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  Pull request review
                </code>
                . If you skip <code>Push</code>, use the <strong>Sync now</strong>{" "}
                button on the CLA page to publish repo-file changes manually.{" "}
                <strong>Merge group</strong> is required if you put the checker&apos;s
                status checks behind a GitHub <strong>merge queue</strong>: the queue
                builds a temporary commit and re-requests checks on it, so without
                this event the queue waits forever and never merges.{" "}
                <strong>Pull request review</strong> is required if you use{" "}
                <strong>guarded paths</strong>: it is the only event that says an
                approval arrived, so without it approving a PR to clear the guard
                does nothing visible until somebody pushes again, which reads as
                the check being broken.
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
                <CodeBlock className="mt-2" language=".env" code={`GITHUB_APP_ID="<the App ID>"
GITHUB_APP_SLUG="<the slug: last segment of the app's URL>"
GITHUB_APP_CLIENT_ID="<Client ID>"
GITHUB_APP_CLIENT_SECRET="<Client secret>"
GITHUB_APP_WEBHOOK_SECRET="<the random secret you generated>"
# PEM with literal \\n between lines, all on one line, in double quotes:
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"`} />
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
