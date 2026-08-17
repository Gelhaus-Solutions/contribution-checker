import Link from "next/link";
import type { Metadata } from "next";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Section, Steps } from "@/components/marketing/section";
import { SpecTable } from "@/components/marketing/spec-table";
import { PrCommentCard } from "@/components/marketing/pr-comment-card";
import {
  CheckRunPanel,
  CheckRunRow,
} from "@/components/marketing/check-run-row";
import { HeuristicGroupSummary } from "@/components/marketing/heuristic-table";
import { buildDecisionMessage } from "@/lib/applications/decision-message";
import { buildDecisionCheckPayload } from "@/lib/github/check-run";
import { ALL_HEURISTICS } from "@/lib/quality/registry";

export const metadata: Metadata = {
  title: "Gate pull requests behind a contributor application",
  description:
    "Self-hosted GitHub App that decides whether a pull request author is allowed to contribute, closes the ones that are not, and reopens them when you approve.",
};

// A fixed example project, so the rendered artifacts below read like a real
// repository rather than a placeholder.
const EXAMPLE = {
  projectName: "Acme Router",
  ghLogin: "octocat",
  applyUrl: "https://checker.example.com/p/acme-router",
  claUrl: "https://checker.example.com/p/acme-router/cla",
};

export default async function Home() {
  const session = await auth();

  // Every artifact on this page is produced by the same functions the webhook
  // calls. Nothing here is retyped marketing copy.
  const noApplication = buildDecisionMessage({
    decision: { status: "PENDING", reason: "no-application" },
    ...EXAMPLE,
  })!;
  const underReview = buildDecisionMessage({
    decision: { status: "PENDING", reason: "submitted" },
    ...EXAMPLE,
  })!;
  const claRequired = buildDecisionMessage({
    decision: { status: "CHECK_REQUIRED", reason: "cla_required" },
    ...EXAMPLE,
  })!;

  const check = (d: Parameters<typeof buildDecisionCheckPayload>[0]["decision"]) =>
    buildDecisionCheckPayload({
      decision: d,
      applyUrl: EXAMPLE.applyUrl,
      projectName: EXAMPLE.projectName,
      claUrl: EXAMPLE.claUrl,
    });

  const enabledByDefault = ALL_HEURISTICS.filter((h) => h.defaultEnabled).length;

  return (
    <>
      {/* Statement. Two columns on xl: a hero with an empty right half reads as
          unfinished on a wide screen, and the gate's actual output is the most
          useful thing to put there. These rows are the real payload, same as
          everywhere else on the page. */}
      <section className="py-14 md:py-20">
        <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] xl:items-center xl:gap-x-16">
          <div>
            <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance md:text-4xl xl:text-5xl">
              Every pull request goes through a gate you control.
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
              contribution-checker is a self-hosted GitHub App. When someone
              opens a pull request on a linked repository, it decides whether
              that author is allowed to contribute. If they are not, it closes
              the pull request and leaves a comment pointing at your application
              form. When you approve them, it reopens the pull request.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button asChild>
                <Link href="/how-it-works">Read how it works</Link>
              </Button>
              {session?.user ? (
                <Button asChild variant="outline">
                  <Link href="/dashboard">Go to dashboard</Link>
                </Button>
              ) : (
                <form
                  action={async () => {
                    "use server";
                    await signIn("github");
                  }}
                >
                  <SubmitButton variant="outline">Log in</SubmitButton>
                </form>
              )}
              <p className="text-xs text-muted-foreground">
                AGPL-3.0. Runs on your own Postgres.
              </p>
            </div>
          </div>

          <div className="mt-12 xl:mt-0">
            <p className="mb-2 font-mono text-xs text-muted-foreground">
              contribution-checker / decision
            </p>
            <CheckRunPanel>
              <CheckRunRow payload={check({ status: "APPROVED" })} />
              <CheckRunRow
                payload={check({ status: "PENDING", reason: "no-application" })}
              />
              <CheckRunRow
                payload={check({
                  status: "CHECK_REQUIRED",
                  reason: "cla_required",
                })}
              />
              <CheckRunRow
                payload={check({
                  status: "DENIED",
                  cooldownUntil: new Date("2026-09-01T00:00:00Z"),
                })}
              />
            </CheckRunPanel>
            <p className="mt-2 text-xs text-muted-foreground">
              Require this check in branch protection and an unapproved
              contributor cannot merge.
            </p>
          </div>
        </div>
      </section>

      <Section
        title="What lands on the pull request"
        lead="Three things, at most: a comment, a label, and a status check. Everything below is the real output, rendered by the same functions the webhook calls."
      >
        <div className="space-y-8">
          <div className="space-y-3">
            <PrCommentCard body={noApplication} label="No application on file" />
            <CheckRunPanel>
              <CheckRunRow
                payload={check({ status: "PENDING", reason: "no-application" })}
              />
            </CheckRunPanel>
          </div>

          <div className="space-y-3">
            <PrCommentCard body={underReview} label="Application under review" />
            <CheckRunPanel>
              <CheckRunRow
                payload={check({ status: "PENDING", reason: "submitted" })}
              />
            </CheckRunPanel>
          </div>

          <div className="space-y-3">
            <PrCommentCard body={claRequired} label="CLA not signed" />
            <CheckRunPanel>
              <CheckRunRow
                payload={check({
                  status: "CHECK_REQUIRED",
                  reason: "cla_required",
                })}
              />
            </CheckRunPanel>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The CLA and DCO gates are the exception. They leave the pull
              request open and fail a check instead of closing it.
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="How the decision is made"
        lead="One function, and the checks run in order. The first match wins."
      >
        <Steps
          items={[
            <>
              <code>repo.active</code> is false. The repository was uninstalled,
              so nothing happens.
            </>,
            <>
              <code>checkerEnabled</code> is false. Everything is approved and
              the pull request is left alone.
            </>,
            <>
              A maintainer set a manual <strong>denial</strong> for this login.
              Denied, and the pipeline stops here.
            </>,
            <>
              The login matches the bypass list, for example{" "}
              <code>*[bot]</code>. Bypassed, and exempt from the CLA.
            </>,
            <>
              A maintainer set a manual <strong>approval</strong>. Approved.
            </>,
            <>
              The author is a repository collaborator and{" "}
              <code>bypassCollabs</code> is on. Bypassed.
            </>,
            <>
              The author&apos;s latest application decides it: approved, denied,
              or pending.
            </>,
          ]}
        />
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          An allowing result then passes through the CLA check, and after that
          the DCO check.{" "}
          <Link
            href="/how-it-works#precedence"
            className="text-primary underline-offset-2 hover:underline"
          >
            The full pipeline
          </Link>
        </p>
      </Section>

      <Section title="Quality scoring that does not call a model">
        <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-start">
          <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              Every pull request can be scored 0 to 100. The score comes from{" "}
              {ALL_HEURISTICS.length} heuristics that read the diff, the
              commits, the pull request body, and the author&apos;s public
              profile. They are ordinary functions. There is no API key, no
              inference, no third party, and no per-pull-request cost. The same
              pull request scores the same number every time.
            </p>
            <p>
              Scores are visible to maintainers only. The one public surface is
              a warning comment, posted when the score falls under the
              project&apos;s threshold.
            </p>
            <p>
              <Link
                href="/quality"
                className="text-primary underline-offset-2 hover:underline"
              >
                What the score means
              </Link>
            </p>
          </div>
          <div className="md:w-80">
            <HeuristicGroupSummary />
            <p className="mt-2 text-xs text-muted-foreground">
              {enabledByDefault} of {ALL_HEURISTICS.length} are on by default.
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="App mode or GitHub Actions"
        lead="Install the GitHub App if you can. If org policy will not let you, the same gate runs from inside Actions, authenticated with the workflow's OIDC token. There are no shared secrets to rotate in either case."
      >
        <SpecTable
          head={["", "App mode", "CI mode"]}
          rows={[
            ["Install", "GitHub App on the repository", "Two workflow files"],
            [
              "Auth",
              "Installation token",
              "Actions OIDC JWT, verified against GitHub's JWKS",
            ],
            [
              "Trigger",
              <code key="a">pull_request</code>,
              <code key="b">pull_request_target</code>,
            ],
            [
              "Reopen after approval",
              "Immediate",
              "Up to 10 minutes, on the reconcile cron",
            ],
            [
              "Collaborator auto-bypass",
              "Yes",
              "No, list them in bypass handles",
            ],
            ["Status checks", "Yes", "Via the workflow"],
            [
              "Quality scoring",
              "Yes",
              <>
                Only if the workflow sends <code>qualityContext</code>
              </>,
            ],
          ]}
        />
      </Section>

      <Section title="It runs on your infrastructure">
        <dl className="grid gap-6 sm:grid-cols-2">
          {[
            [
              "Stack",
              "Next.js 15, Prisma, PostgreSQL. One Docker image, one database.",
            ],
            [
              "Secrets",
              "Environment variables, or HashiCorp Vault for the GitHub App key, the webhook secret, and SMTP.",
            ],
            [
              "Data",
              "Applications, decisions, the audit log and PR scores stay in your database. Nothing is sent anywhere else.",
            ],
            ["Licence", "AGPL-3.0-or-later."],
          ].map(([term, def]) => (
            <div key={term}>
              <dt className="text-sm font-medium">{term}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {def}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Set it up">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Create the GitHub App, install it on a repository, then link the
          repository to a project. The setup page prints the exact URLs and
          permissions for your instance.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/admin/setup">GitHub App setup</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/how-it-works">How it works</Link>
          </Button>
        </div>
      </Section>
    </>
  );
}
