import Link from "next/link";
import type { Metadata } from "next";
import { Section, Steps, Note } from "@/components/marketing/section";
import { SpecTable } from "@/components/marketing/spec-table";
import { PrCommentCard } from "@/components/marketing/pr-comment-card";
import { CodeBlock } from "@/components/code-block";
import { buildDecisionMessage } from "@/lib/applications/decision-message";

export const metadata: Metadata = {
  title: "Your pull request was closed automatically",
  description:
    "Why a bot closed your pull request, what to do next, and what happens after you apply.",
};

const EXAMPLE = {
  projectName: "Acme Router",
  ghLogin: "octocat",
  applyUrl: "https://checker.example.com/p/acme-router",
  claUrl: "https://checker.example.com/p/acme-router/cla",
};

const SIGNOFF = `# amend the latest commit
git commit -s --amend

# or sign off the whole branch, then force-push
git rebase --signoff`;

export default function ForContributorsPage() {
  const closedComment = buildDecisionMessage({
    decision: { status: "PENDING", reason: "no-application" },
    ...EXAMPLE,
  })!;
  const dcoComment = buildDecisionMessage({
    decision: { status: "CHECK_REQUIRED", reason: "dco_missing" },
    ...EXAMPLE,
  })!;

  return (
    <div className="mx-auto max-w-2xl">
      <header className="py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Your pull request was closed automatically
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          A bot closed it, not a person. No reviewer has looked at your code
          yet. Here is what happened and what to do next.
        </p>
      </header>

      <Section title="What happened">
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          This project gates pull requests behind an application. The bot
          checked whether your GitHub account had been approved for it, found no
          application, closed the pull request, and left this comment.
        </p>
        <PrCommentCard body={closedComment} />
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          Your work is not lost. The branch, the commits and the diff are all
          still there. Closing a pull request changes nothing in the repository.
        </p>
      </Section>

      <Section title="What to do">
        <Steps
          items={[
            "Open the link in the comment. It goes to the project's application page.",
            "Sign in with GitHub. The approval is tied to your GitHub account id, so the account you sign in with has to be the account that opened the pull request.",
            "Fill in the form. The questions are written by the project's maintainers.",
            "Submit, and wait for a maintainer to review it.",
            "When you are approved, your pull request reopens by itself. So does every other pull request of yours the bot closed in that project.",
          ]}
        />
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          You do not need to open a new pull request. A second one will be
          closed for the same reason.
        </p>
      </Section>

      <Section title="If the comment said something else">
        <SpecTable
          head={["The comment says", "What it means"]}
          rows={[
            [
              "Your application is awaiting review",
              "It arrived. A maintainer has not reached it yet. The pull request reopens on approval.",
            ],
            [
              "You need to sign a Contributor License Agreement",
              "Your pull request is still open. Sign at the link and the check clears by itself.",
            ],
            [
              "The CLA was updated and needs re-signing",
              "The same, for a new version of the agreement.",
            ],
            [
              "Commits are missing a sign-off",
              "Your pull request is still open. See below.",
            ],
            [
              "Your application was previously declined",
              "See below.",
            ],
          ]}
        />
      </Section>

      <Section id="sign-off" title="Missing sign-off">
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          Some projects require a Developer Certificate of Origin trailer on
          every commit. Your pull request stays open. Add the trailer and the
          check clears on your next push.
        </p>
        <CodeBlock code={SIGNOFF} language="bash" />
        <div className="mt-6">
          <PrCommentCard body={dcoComment} label="What the bot posts" />
        </div>
      </Section>

      <Section id="declined" title="If you were declined">
        <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            The reason is not posted on the pull request, deliberately. It is on
            your application status page, which you can read while signed in,
            and it is in the email you were sent.
          </p>
          <p>
            If the project set a cooldown, the comment names the date you can
            apply again. If it did not, the decision stands until a maintainer
            changes it.
          </p>
          <p>
            Some projects allow one appeal per application. If yours does, an
            appeal form is on your status page. An appeal can be granted,
            granted with permission to submit a fresh application, or rejected.
          </p>
        </div>
      </Section>

      <Section title="If you got a quality warning">
        <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Some projects score pull requests and post a comment when the score
            is low. It does not block anything. It is a heads-up before a
            reviewer looks.
          </p>
          <p>
            The score is arithmetic, described on the{" "}
            <Link
              href="/quality"
              className="text-primary underline-offset-2 hover:underline"
            >
              quality page
            </Link>
            . If a heuristic flagged something you disagree with, say so in the
            pull request. A person makes the call.
          </p>
        </div>
      </Section>

      <Section title="What this is not">
        <Note>
          <div className="space-y-3">
            <p>
              No language model reads your code, your commits, or your
              application. The gate is a lookup on your GitHub account. The
              quality score, if the project uses one, is a fixed set of pattern
              checks with fixed weights. Nothing you write is sent to a third
              party.
            </p>
            <p>
              The project&apos;s maintainers decide who is approved. This
              software enforces that decision, it does not make it.
            </p>
          </div>
        </Note>
      </Section>
    </div>
  );
}
