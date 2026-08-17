import Link from "next/link";
import type { Metadata } from "next";
import { Section, Steps, Note } from "@/components/marketing/section";
import { SpecTable } from "@/components/marketing/spec-table";
import {
  CheckRunPanel,
  CheckRunRow,
} from "@/components/marketing/check-run-row";
import { buildDecisionCheckPayload } from "@/lib/github/check-run";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "The gating pipeline",
  description:
    "What happens between a contributor opening a pull request and it being closed, labelled, checked and scored.",
};

const EXAMPLE = {
  applyUrl: "https://checker.example.com/p/acme-router",
  claUrl: "https://checker.example.com/p/acme-router/cla",
  projectName: "Acme Router",
};

const TOC = [
  { href: "#events", label: "Trigger events" },
  { href: "#precedence", label: "Precedence" },
  { href: "#outcomes", label: "The outcomes" },
  { href: "#checks", label: "The status check" },
  { href: "#order", label: "Order of operations" },
  { href: "#after", label: "After the decision" },
  { href: "#ci-mode", label: "GitHub Actions mode" },
  { href: "#failures", label: "When something breaks" },
];

export default function HowItWorksPage() {
  const check = (
    decision: Parameters<typeof buildDecisionCheckPayload>[0]["decision"],
  ) => buildDecisionCheckPayload({ decision, ...EXAMPLE });

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_11rem] lg:gap-10">
      <div className="min-w-0">
        <header className="py-14">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            The gating pipeline
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            What happens between a contributor clicking &ldquo;Create pull
            request&rdquo; and the pull request being closed, labelled, checked
            and scored. This page describes the GitHub App path. The Actions
            path runs the same decision function and is covered at the end.
          </p>
        </header>

        <Section
          id="events"
          title="Events that trigger a run"
          lead="The webhook handler acts on six pull_request actions and ignores everything else."
        >
          <SpecTable
            mono={[0]}
            head={["Action", "What it does"]}
            rows={[
              ["opened", "Full run."],
              ["reopened", "Full run."],
              ["ready_for_review", "Full run."],
              [
                "synchronize",
                "Full run, and the stored Check Run ids are cleared because the head SHA moved.",
              ],
              [
                "labeled",
                <>
                  Only when the label is the project&apos;s{" "}
                  <code>labelEvaluate</code>, default{" "}
                  <code>contribution:evaluate</code>. Any other label, including
                  the bot&apos;s own, exits before touching the database.
                </>,
              ],
              [
                "closed",
                "Records whether the close was terminal. A merge or a human close ends the pull request; a close the bot performed stays reopenable.",
              ],
            ]}
          />
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Adding the evaluate label by hand is the manual re-run. The label is
            always removed afterwards, whether or not labels are enabled, so it
            does not retrigger on the next event.
          </p>
        </Section>

        <Section
          id="precedence"
          title="Precedence"
          lead="decideForRepo returns one of six statuses. The checks run in this order and the first match wins."
        >
          <Steps
            items={[
              <>
                <strong>Repository inactive.</strong> <code>IGNORED</code>. The
                installation was removed.
              </>,
              <>
                <strong>Checker disabled.</strong> <code>checkerEnabled</code>{" "}
                is false, so the result is <code>APPROVED</code> with the reason{" "}
                <code>checker_disabled</code>. The pull request is not closed
                and no pending or denied label is applied. Whether a row is
                written at all depends on <code>trackWhenDisabled</code>.
              </>,
              <>
                <strong>Manual denial.</strong> A maintainer denied this login
                directly. <code>DENIED</code>, and the pipeline stops here. A
                denied contributor is never asked to sign a CLA.
              </>,
              <>
                <strong>Bypass list.</strong> The login matches a glob in{" "}
                <code>bypassHandles</code>, for example <code>*[bot]</code>.{" "}
                <code>BYPASSED</code>, and the pipeline stops here, which is
                what exempts bots from the CLA and DCO gates.
              </>,
              <>
                <strong>Manual approval.</strong> <code>APPROVED</code>, but not
                returned yet. The CLA layer below still applies.
              </>,
              <>
                <strong>Collaborator.</strong> <code>bypassCollabs</code> is on
                and GitHub confirms the author is a collaborator.{" "}
                <code>BYPASSED</code>, cached for five minutes. If the
                collaborator call fails, the failure is logged and the pipeline
                falls through to the application check rather than guessing.
              </>,
              <>
                <strong>Application.</strong> The author&apos;s latest
                application for this project decides it. Approved means
                approved. Denied with no resubmission allowed, or denied inside
                a cooldown, means <code>DENIED</code>. Denied with the cooldown
                elapsed becomes <code>PENDING</code>. Submitted but undecided is{" "}
                <code>PENDING</code>. No application at all is{" "}
                <code>PENDING</code>.
              </>,
            ]}
          />
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
            If <code>applicationRequired</code> is off, a missing or undecided
            application no longer blocks. An existing denial still does.
          </p>

          <div className="mt-8 space-y-4">
            <Note title="The CLA gate layers on top">
              It only applies to a result that was already going to allow the
              pull request: an approval, or a collaborator bypass. It is never
              applied to a denial, and never to the bot bypass. An unsigned or
              out-of-date CLA turns that allowing result into{" "}
              <code>CHECK_REQUIRED</code>.
            </Note>
            <Note title="DCO is checked later">
              It runs in the side-effect layer, because it needs the pull
              request&apos;s commit list and the decision path does not load it.
              A missing <code>Signed-off-by</code> trailer overrides an allowing
              result the same way. If the commit fetch fails, DCO passes.
              Infrastructure trouble never blocks a contributor.
            </Note>
          </div>
        </Section>

        <Section id="outcomes" title="What each outcome does">
          <SpecTable
            mono={[0]}
            head={[
              "Status",
              "Pull request",
              "Comment",
              "Label",
              "Decision check",
            ]}
            rows={[
              [
                "APPROVED",
                "Left open",
                "None",
                "approved",
                <Badge key="a" variant="success">
                  success
                </Badge>,
              ],
              [
                "APPROVED (checker_disabled)",
                "Left open",
                "None",
                "approved",
                <Badge key="b" variant="success">
                  success
                </Badge>,
              ],
              [
                "BYPASSED",
                "Left open",
                "None",
                "approved",
                <Badge key="c" variant="success">
                  success
                </Badge>,
              ],
              [
                "PENDING",
                <strong key="d">Closed</strong>,
                "Apply link, or awaiting review",
                "pending",
                <Badge key="e" variant="warning">
                  action_required
                </Badge>,
              ],
              [
                "CHECK_REQUIRED",
                <strong key="f">Left open</strong>,
                "Sign the CLA, or add the sign-off",
                "cla-pending",
                <Badge key="g" variant="warning">
                  action_required
                </Badge>,
              ],
              [
                "DENIED",
                <strong key="h">Closed</strong>,
                "Link to status page, no reason",
                "denied",
                <Badge key="i" variant="destructive">
                  failure
                </Badge>,
              ],
              ["IGNORED", "Nothing", "None", "None", "None"],
            ]}
          />

          <div className="mt-6 space-y-4">
            <Note title="The denial reason is never posted on GitHub">
              It is in neither the comment nor the Check Run summary. The
              applicant reads it on their own status page while signed in, and
              by email. Maintainers see it in the dashboard.
            </Note>
            <Note title="Labels are optional">
              With <code>labelsEnabled</code> off, every close, comment and
              check still happens. The four labels are created on demand with
              fixed colours: pending <code>#fbca04</code>, approved{" "}
              <code>#0e8a16</code>, denied <code>#b60205</code>, evaluate{" "}
              <code>#5319e7</code>.
            </Note>
          </div>
        </Section>

        <Section
          id="checks"
          title="The status check"
          lead="One Check Run named contribution-checker / decision, published against the pull request's head SHA. Require it in branch protection and an unapproved contributor cannot merge, even if someone reopens the pull request by hand."
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Every state below is produced by the same function the webhook
            calls.
          </p>
          <CheckRunPanel>
            <CheckRunRow payload={check({ status: "APPROVED" })} />
            <CheckRunRow
              payload={check({
                status: "APPROVED",
                bypassReason: "checker_disabled",
              })}
            />
            <CheckRunRow
              payload={check({ status: "BYPASSED", reason: "bot" })}
            />
            <CheckRunRow
              payload={check({ status: "BYPASSED", reason: "collaborator" })}
            />
            <CheckRunRow
              payload={check({ status: "PENDING", reason: "no-application" })}
            />
            <CheckRunRow
              payload={check({ status: "PENDING", reason: "submitted" })}
            />
            <CheckRunRow
              payload={check({
                status: "CHECK_REQUIRED",
                reason: "cla_required",
              })}
            />
            <CheckRunRow
              payload={check({ status: "CHECK_REQUIRED", reason: "cla_stale" })}
            />
            <CheckRunRow
              payload={check({
                status: "CHECK_REQUIRED",
                reason: "dco_missing",
              })}
            />
            <CheckRunRow
              payload={check({
                status: "DENIED",
                cooldownUntil: new Date("2026-09-01T00:00:00Z"),
              })}
            />
          </CheckRunPanel>

          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
            Projects with a CLA get a second, independent check named{" "}
            <code>contribution-checker / cla</code>. It reports the
            author&apos;s signature coverage directly rather than the overall
            decision, so it can be required on its own.
          </p>
          <div className="mt-4">
            <Note title="No check is published when">
              the project has checks turned off, the payload carries no head
              SHA, or the installation has not been granted{" "}
              <code>checks:write</code>. The last one is silent by design: it is
              feature-detected, so an installation that has not accepted the
              newer permissions keeps working instead of erroring on every pull
              request.
            </Note>
          </div>
        </Section>

        <Section
          id="order"
          title="Order of operations"
          lead="For a single pull request event, convergePr runs this sequence."
        >
          <Steps
            items={[
              "Decide.",
              "Load the project's labels, gates and quality settings. Exit if the project is gone.",
              "Apply the DCO layer, which may override the decision.",
              "Work out the standalone CLA state, separately from the decision, so the CLA check stays accurate on paths where the decision short-circuited earlier.",
              <>
                Write or update the <code>PrCheck</code> row. An active CLA or
                DCO gate always writes one, even when tracking is otherwise off,
                because the re-check sweep finds affected pull requests by their
                gate reason.
              </>,
              "Create the labels if they are missing.",
              "Apply the outcome: reopen, or close with a comment, or comment and keep open.",
              "Publish the decision check, then the CLA check.",
              "Run quality scoring, if it is enabled and a row exists.",
            ]}
          />
          <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              Every step is idempotent, so a redelivered webhook converges to
              the same state instead of stacking duplicate comments. The gate
              comment is posted once per gate reason. The quality warning
              comment is claimed atomically before it is sent, so concurrent
              deliveries cannot double-post.
            </p>
            <p>
              Nothing after step 5 can fail the request. Each side effect is
              caught and logged. The handler returns 200 unless the signature is
              invalid, because a non-200 makes GitHub retry the delivery
              indefinitely.
            </p>
          </div>
        </Section>

        <Section id="after" title="Approval, denial, revocation">
          <div className="space-y-6 text-sm leading-relaxed">
            <div>
              <p className="font-medium">On approval</p>
              <p className="mt-1 text-muted-foreground">
                Every pull request the bot closed for that author, across every
                linked repository in the project, is reopened with a comment
                naming the project, relabelled to approved, and marked approved.
                Both pull requests closed as pending and those closed as denied
                are reopened. The flag that says &ldquo;we closed this&rdquo; is
                what makes it safe: pull requests the contributor closed
                themselves are never touched.
              </p>
            </div>
            <div>
              <p className="font-medium">On denial</p>
              <p className="mt-1 text-muted-foreground">
                Previously closed pull requests are not reopened. They get the
                denial comment and the denied label, and stay closed.
              </p>
            </div>
            <div>
              <p className="font-medium">On revocation</p>
              <p className="mt-1 text-muted-foreground">
                Optional. When the maintainer ticks the box, currently open pull
                requests from that contributor are closed with a comment linking
                to their status page. The reason is not published.
              </p>
            </div>
          </div>
        </Section>

        <Section
          id="ci-mode"
          title="Running it from GitHub Actions"
          lead="If you cannot install a GitHub App, two workflow files do the same job from inside the repository."
        >
          <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              Requests carry the OIDC token GitHub mints for the workflow. The
              server checks its signature against GitHub&apos;s JWKS and then
              trusts two claims: <code>aud</code>, which must be your
              instance&apos;s URL for that exact project, and{" "}
              <code>repository</code>, which must be a repository registered
              under that project. There is no shared secret to configure or
              rotate, and a leaked token is worthless after about six minutes.
            </p>
            <p>
              The gate workflow uses <code>pull_request_target</code> so the
              token exists for fork pull requests. It never checks out the pull
              request head. Only the base branch&apos;s workflow file runs,
              which closes the usual <code>pull_request_target</code> injection
              hole.
            </p>
            <p>
              The exact YAML is generated per project. Copy it from the
              project&apos;s Repos tab.
            </p>
          </div>
        </Section>

        <Section
          id="failures"
          title="When something breaks"
          lead="The gate is built to fail open rather than trap a contributor."
        >
          <SpecTable
            head={["Failure", "Result"]}
            rows={[
              [
                "Collaborator lookup errors",
                "Logged, falls through to the application check.",
              ],
              ["Commit fetch for DCO errors", "DCO passes."],
              [
                <>
                  Installation lacks <code key="c">checks:write</code>
                </>,
                "No check published, everything else runs.",
              ],
              [
                "Comment, label, close or check call errors",
                "Logged, the handler still returns 200.",
              ],
              ["Invalid webhook signature", "401, nothing runs."],
            ]}
          />
        </Section>

        <Section title="Next">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link
              href="/quality"
              className="text-primary underline-offset-2 hover:underline"
            >
              What the quality score means
            </Link>
            <Link
              href="/for-contributors"
              className="text-primary underline-offset-2 hover:underline"
            >
              The contributor&apos;s view
            </Link>
            <Link
              href="/admin/setup"
              className="text-primary underline-offset-2 hover:underline"
            >
              GitHub App setup
            </Link>
          </div>
        </Section>
      </div>

      {/* Table of contents. Sticky on wide screens only; below lg it would
          just push the article down. */}
      <nav
        aria-label="On this page"
        className="hidden lg:sticky lg:top-20 lg:block lg:self-start lg:py-14"
      >
        <p className="mb-3 font-mono text-xs tracking-wide text-muted-foreground uppercase">
          On this page
        </p>
        <ul className="space-y-2 border-l border-border">
          {TOC.map((t) => (
            <li key={t.href}>
              <a
                href={t.href}
                className="-ml-px block border-l border-transparent pl-3 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                {t.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
