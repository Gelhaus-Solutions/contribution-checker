import Link from "next/link";
import type { Metadata } from "next";
import { Section, Steps, Note } from "@/components/marketing/section";
import { SpecTable } from "@/components/marketing/spec-table";
import { HeuristicTable } from "@/components/marketing/heuristic-table";
import { CodeBlock } from "@/components/code-block";
import { Badge } from "@/components/ui/badge";
import { ALL_HEURISTICS } from "@/lib/quality/registry";

export const metadata: Metadata = {
  title: "The PR quality score",
  description:
    "How the 0 to 100 pull request quality score is computed: deterministic heuristics, fixed weights, and no model calls.",
};

const FORMULA = `const W4_SCORE_CAPS = [50, 35, 20];
const PENALTY_PER_WEIGHT = 10;

ceiling = min(perSignalCaps..., w4Cap(blockersFired))
score   = max(0, ceiling - deductions)`;

export default function QualityPage() {
  const total = ALL_HEURISTICS.length;
  const enabled = ALL_HEURISTICS.filter((h) => h.defaultEnabled).length;
  const blockers = ALL_HEURISTICS.filter((h) => h.weight === 4);

  return (
    <>
      <header className="py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          The PR quality score
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          An integer from 0 to 100, or nothing at all. It measures how many
          known low-effort patterns a pull request trips, and nothing else.
        </p>
        <div className="mt-6 max-w-2xl">
          <Note title="No model is involved">
            Every heuristic is a function over the pull request: the file list,
            the diff hunks, the commit messages, the title and body, and the
            author&apos;s public profile. No text leaves your server. The same
            pull request produces the same score on every run, on every
            instance. Adding a model call here is out of scope on purpose.
          </Note>
        </div>
      </header>

      <Section
        title="How the number is produced"
        lead="Every heuristic is a detector for something bad. Passing is the normal case, so the score starts at 100 and comes down."
      >
        <Steps
          items={[
            "Start at a ceiling of 100.",
            "For each blocker that fired, lower the ceiling. One blocker caps the score at 50, two at 35, three or more at 20.",
            "A few heuristics carry their own cap. A trivial patch caps the score at 50, or at 25 if the title is also vague or the body is empty. The lowest cap wins.",
            "For every other heuristic that fired, subtract ten points per weight. Weight 1 costs 10, weight 2 costs 20, weight 3 costs 30.",
            "Some heuristics compute their own penalty instead, so it scales with what they measured: one point per inline code reference over the limit, five points per commit that is not in Conventional Commits form.",
            "Floor at 0.",
          ]}
        />
        <div className="mt-6 max-w-xl">
          <CodeBlock code={FORMULA} language="score.ts" />
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          A heuristic that is turned off is not counted. A heuristic that has
          never run against this pull request is not counted either. If nothing
          ran, there is no score rather than a score of zero.
        </p>
      </Section>

      <Section title="Four examples">
        <SpecTable
          head={["What fired", "Arithmetic", "Score"]}
          rows={[
            [
              "Source added with no tests (w2), one overlong commit message (w1)",
              <code key="a">100 − 20 − 10</code>,
              <strong key="b" className="tabular-nums">
                70
              </strong>,
            ],
            [
              "One AI watermark phrase (blocker), nothing else",
              <code key="c">ceiling 50, no deductions</code>,
              <strong key="d" className="tabular-nums">
                50
              </strong>,
            ],
            [
              "AI watermark and honeypot hit (two blockers), plus emoji count (w1)",
              <code key="e">ceiling 35 − 10</code>,
              <strong key="f" className="tabular-nums">
                25
              </strong>,
            ],
            [
              "All three blockers, plus emoji count (w1)",
              <code key="g">ceiling 20 − 10</code>,
              <strong key="h" className="tabular-nums">
                10
              </strong>,
            ],
          ]}
        />
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          With the default comment threshold of 20, the third example is silent
          and the fourth gets a public warning comment.
        </p>
      </Section>

      <Section
        title="The four weights"
        lead="Weights are fixed in the code. Maintainers can turn a heuristic off or change its threshold. They cannot change what it costs."
      >
        <SpecTable
          head={["Weight", "Meaning", "Effect"]}
          rows={[
            [
              <Badge key="1" variant="secondary">
                1
              </Badge>,
              "Mild",
              <code key="a">−10</code>,
            ],
            [
              <Badge key="2" variant="warning">
                2
              </Badge>,
              "Major",
              <code key="b">−20</code>,
            ],
            [
              <Badge key="3" variant="warning">
                3
              </Badge>,
              "Critical",
              <code key="c">−30</code>,
            ],
            [
              <Badge key="4" variant="destructive">
                4
              </Badge>,
              "Blocker",
              <code key="d">caps the score at 50, 35 or 20</code>,
            ],
          ]}
        />
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Blocker is reserved for {blockers.length} things that are close to
          proof rather than suspicion: a phrase a language model left in the
          body, honeypot text copied out of the pull request template, and
          ignoring the template altogether. Passing everything else should not
          rescue a pull request that did one of those.
        </p>
      </Section>

      <Section
        id="catalogue"
        title="Every heuristic"
        lead={`${total} heuristics in six groups, ${enabled} of them on by default. The identifiers are the exact keys stored on each scored pull request, so a maintainer looking at raw signals can match them one to one.`}
      >
        <HeuristicTable />
        <div className="mt-8 space-y-4">
          <Note>
            The three <code>account</code> heuristics that are off by default
            cost extra GitHub search API calls. They are skipped entirely when
            disabled, so turning them off is a real saving rather than a filter
            applied afterwards.
          </Note>
          <Note>
            <code>pr.title_vague</code> fires on a single vague word (update,
            fix, wip, patch, changes, misc, stuff, chore), on GitHub&apos;s own
            web editor default like <code>Update README.md</code>, on anything
            shorter than eight characters, and on a title that is only emoji.
          </Note>
        </div>
      </Section>

      <Section title="What maintainers can change">
        <div className="grid gap-8 sm:grid-cols-2 text-sm leading-relaxed">
          <div>
            <p className="font-medium">Per project</p>
            <ul className="mt-2 space-y-1.5 text-muted-foreground">
              <li>Whether scoring runs at all. Off by default.</li>
              <li>Which heuristics are enabled.</li>
              <li>Each heuristic&apos;s threshold.</li>
              <li>The honeypot phrases.</li>
              <li>Template match strictness, default 80 percent.</li>
              <li>
                The score below which a public comment is posted, default 20.
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium">Fixed in the code</p>
            <ul className="mt-2 space-y-1.5 text-muted-foreground">
              <li>The weights.</li>
              <li>The blocker caps.</li>
              <li>The ten points per weight.</li>
              <li>What each heuristic actually looks for.</li>
            </ul>
          </div>
        </div>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Changing the configuration takes effect immediately, including on pull
          requests that were scored last month. Raw signals are stored per pull
          request and the score is recomputed from them on every read, so there
          is no recompute job and no stale number.
        </p>
      </Section>

      <Section title="Who sees the score">
        <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Maintainers, in the dashboard. That is the default and usually the
            whole story.
          </p>
          <p>
            The one public surface is the warning comment, posted at most once
            per pull request when the score is under the project&apos;s
            threshold. It names the score and lists which heuristics flagged,
            with their measured values.
          </p>
        </div>
      </Section>

      <Section title="What it does not do">
        <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            It does not read your code for correctness. It does not decide
            whether a change is a good idea. It does not block a merge, and it
            is not wired into branch protection.
          </p>
          <p>
            It flags patterns that correlate with low-effort and
            machine-generated pull requests. That is all it is: correlation. A
            careful one-line fix to a typo trips the trivial patch heuristic and
            scores badly. A sloppy thousand-line pull request with a filled-in
            template can score well. The number is triage, not judgement.
          </p>
          <p>
            <Link
              href="/how-it-works"
              className="text-primary underline-offset-2 hover:underline"
            >
              How the gating decision works
            </Link>
          </p>
        </div>
      </Section>
    </>
  );
}
