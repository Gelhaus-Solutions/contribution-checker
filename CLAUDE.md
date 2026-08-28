# CLAUDE.md

Guide for Claude Code (and humans) working in this repository. Read this before
making non-trivial changes.

## What this is

Self-hosted Next.js app that gates GitHub pull requests behind a contributor
application form. When an unapproved user opens a PR on a linked repo:

1. The bot evaluates the author against the project's rules (manual decisions,
   bypass list, collaborator bypass, application status).
2. If approved/bypassed, the PR is left open and labeled.
3. If pending (no application), the PR is closed with a comment linking to the
   apply page, labeled "pending".
4. If denied, the PR is closed with a "denied" label. The denial reason is
   **not** posted on GitHub; the applicant reads it on their status page.
5. If a CLA or DCO gate fires (`CHECK_REQUIRED`), the PR is **left open**, a
   comment explains what to sign or add, and the check fails.
6. A GitHub Check Run is published mirroring the decision (success /
   action_required / failure) so branch protection sees the gate. There is no
   `skipped` conclusion: the fourth state is "no check published at all", when
   `checksEnabled` is false, the payload has no head SHA, or the installation
   lacks `checks:write`.
7. If PR Quality scoring is enabled, a 0–100% heuristic score is computed and
   stored. Scores are admin-only by default, with a public warning comment when
   the score falls below the project's threshold.
8. When the application is later approved, all closed-by-app PRs from that user
   are reopened.

The bot runs in two modes per repo:

- **App mode**: installed as a GitHub App, receives webhooks. Recommended.
- **CI mode**: uses GitHub Actions OIDC tokens. The workflow file is generated
  per-project and dropped into the repo's `.github/workflows/`.

## Tech stack

- Next.js 15 App Router + React 19
- Prisma + PostgreSQL
- Hexclave (self-hosted Stack Auth fork, `@hexclave/next`) for human login;
  GitHub OAuth is configured inside Hexclave. Cookie sessions + edge middleware.
- `@octokit/app` + `@octokit/webhooks` for the App
- `jose` for verifying GitHub Actions OIDC JWTs
- Tailwind v4 + shadcn-style UI primitives
- pino logger, Zod for validation
- Vitest (unit), Playwright (e2e)

## Critical files

Decision pipeline:
- `src/lib/applications/decide-pr.ts`: precedence is repo active → disable
  switch → manual **DENIED** → bypass list → manual **APPROVED** →
  collaborator → application, then the CLA layer on top. Note the asymmetry:
  a manual denial short-circuits *before* the bypass list, while a manual
  approval is evaluated *after* it, which is what makes bots exempt from the
  CLA. Returns six statuses: `APPROVED`, `BYPASSED`, `PENDING`,
  `CHECK_REQUIRED`, `DENIED`, `IGNORED`.
- `src/lib/github/webhook.ts`: App webhook entrypoint; orchestrates close/
  label/comment + Check Run + Quality
- `src/app/api/github/webhook/route.ts`: signature verification + dispatch
- `src/app/api/ci/check-pr/route.ts`: CI mode entrypoint (OIDC-gated); returns
  a payload the workflow uses to mutate the PR
- `src/lib/github/post-decision.ts`: reopen prior closed PRs on application
  approval; close prior approved PRs on revoke

Staging routing (`src/lib/github/staging.ts`, App mode only):
- `applyStagingRouting`: rewrites a PR based on the default branch to target
  `Project.stagingBranch`. Runs in `handlePullRequestEvent` **before**, and
  independently of, `convergePr`. Loop-safe by construction: the retarget only
  fires when the current base *is* the default branch, so our own PATCH's
  `pull_request.edited` echo is inert. A per-process TTL fuse caps a genuine
  ping-pong with a human or a competing automation.
- `reconcileStagingBatch`: keeps one bot-owned aggregate PR open from staging to
  the default branch and rewrites the manifest between the
  `<!-- staging-batch:start/end -->` markers, preserving human text outside
  them. A full re-derivation from live GitHub, so it is safe to run any number
  of times; it PATCHes the body only when the rendered block actually changed.
  Batch membership is **merge commit reachability**: a PR ships in this batch
  when its `merge_commit_sha` is one of the commits in `default...staging`.
  Re-derived on every run, so a dropped webhook cannot leave it stale.
- **Never use a timestamp as the batch cutoff.** The obvious-looking
  `mergedAt > mergeBaseDate` is wrong, and wrong in a way that empties the
  manifest silently: `syncStagingWithDefault` merges the default branch into
  staging, which makes the merge base the default branch's *tip*, a commit
  created seconds ago. Every PR merged into staging before the last sync then
  falls outside the cutoff. This shipped and blanked a live release PR. The
  timestamp survives only as the fallback for a compare truncated at GitHub's
  250-commit inline limit (`truncated`).
- **The manifest lists merged PRs only.** Open and closed-without-merging PRs
  are excluded: the description is a record of what the batch ships, not of
  what was proposed.
- **The "before you merge" digest** (`src/lib/github/staging-digest.ts`) is the
  second half of the aggregate PR body: environment variables the batch adds or
  drops, database migrations and schema edits, dependency, CI and
  infrastructure changes, and breaking-change commits, plus a diff-stat line.
  It is derived entirely from the `default...staging` compare the reconcile
  already fetches (that response carries the changed files, their patches and
  the commit messages whether we read them or not), so it costs **no extra
  GitHub call**. Everything in it is a pure heuristic over the diff, it renders
  nothing when a batch has nothing notable, and `safeDigest` swallows any
  failure: the digest is advisory, the manifest is not, so a regex that trips
  over an odd patch must never cost the release PR its list of PRs. Env vars
  are picked up both from declaration files (`.env*`, `env.ts` and the like,
  where the name starts the line) and from reads in added code
  (`process.env.X`, `os.getenv("X")`, ...); a name on both sides of the same
  file's diff is a move, not a change, and is dropped. Keep the output
  deterministic (sorted, capped) or every reconcile becomes a visible edit on
  the release PR.
- **The digest is configured per section.** `DIGEST_SECTIONS` is the catalog
  the settings UI renders from, exactly as `ALL_HEURISTICS` is for quality
  scoring: add a section there and its checkbox appears with no further UI work
  and no migration. A project stores the subset it wants in
  `Project.stagingDigestSections` (JSON array of ids, read with
  `parseDigestSections`, never a bare `JSON.parse`), behind the
  `Project.stagingDigestEnabled` switch, which `Repo.stagingDigestEnabled`
  overrides per repo. All of it resolves through `resolveStagingConfig` like
  every other staging setting. Six section ids double as `GROUPS` ids, which is
  what makes a file group's checkbox work with no extra wiring; a group whose
  id is not in the catalog can never be printed. The digest is built in full
  and filtered at render, so a disabled section costs a line and nothing else.
  Off by default, including for projects that already run an aggregate PR: it
  changes the shape of a description reviewers are used to, and a release PR is
  the wrong place to surprise someone.
- **A merge commit in the range is not proof the batch ships it.** When a
  branch is merged into staging *and* separately into the default branch, the
  staging merge commit is still unique to staging while its content is already
  shipped. `mergeAlreadyOnDefault` drops those by checking the merge's
  head-side parents: if none is in the batch, the merge brought nothing new. A
  single-parent merge commit is a squash or rebase merge, whose commit *is* the
  content, so it always counts.
- **Build the manifest before creating the aggregate PR, not after.** GitHub
  fires `pull_request.opened` with whatever body the create call carried, and
  that snapshot is what Slack/Discord/email quote forever. Creating it empty
  and PATCHing afterwards left every integration announcing an empty batch.
- `syncStagingWithDefault`: keeps staging level with the default branch with no
  PR. Fast-forwards the ref when staging has no commits of its own (`aheadBy
  === 0`), otherwise merges via `POST /repos/../merges`, which cannot rewrite
  history. `fastForwardBranch` never passes `force`, so GitHub's 422 is the
  safety net against a stale `aheadBy`. A 409 conflict is a state for a human,
  not an error to retry. The trigger is a **push to the default branch**
  (`handlePushEvent`), without which a repo whose default branch keeps moving
  would never sync at all.
- **Syncs are rate-limited, manifest refreshes are not.** On a staging branch
  with unmerged work each sync is a merge commit, so `STAGING_SYNC_WINDOW_MS`
  (6 h) collapses a burst of default-branch pushes into one.
  `reconcileStagingBatch` owns the window and measures it from
  `Repo.stagingLastSyncAt`, which only a real write (fast-forward or merge)
  stamps: a conflict or a failure leaves the window open so the next request
  retries. It reports `syncDeferred` plus `syncEligibleAtMs`, and the entity
  sleeps until then instead of idling out. **The window must stay in the
  database, not in the entity.** It lived in workflow state once, and the
  entity completes two minutes after the batch settles, so the next push
  started a fresh run that knew of no previous sync and merged immediately:
  the 10-minute window was in practice a 2-minute one, which is what buried
  live staging branches under a merge commit per push.
- `resolveStagingConfig` is the only place that folds per-repo overrides onto
  project defaults; never read the `staging*` columns directly. `syncEnabled`
  is gated on `anyEnabled`, so the sync default cannot touch a repo that is not
  retargeting or batching, and `digestEnabled` is gated on `batchPrEnabled`,
  because the digest is part of the aggregate PR body and has nowhere else to
  go.
- The aggregate PR must **never** reach `convergePr` (no application means the
  gate would close the bot's own release PR). `isAggregatePr` matches it by the
  tracked `Repo.stagingBatchPrNumber` and structurally (same-repo head ==
  staging, base == default), so the pre-tracking window is covered.
- **Skipping the gate must not skip the checks.** The aggregate PR is the one
  PR that has to merge into the default branch, so if `contribution-checker /
  decision` or `/ cla` is required there, publishing nothing leaves the release
  stuck on "waiting for status to be reported" forever. `publishAggregatePrChecks`
  publishes both as success (`APPROVED { bypassReason: "staging_batch" }` and
  CLA `exempt`) before the early return.
- **Every routing outcome is named** (`StagingRoutingOutcome`) and returned on
  `PrEventResult.staging`, so it lands in the `convergePrEvent` activity result
  and is readable from Temporal workflow history when logs are not. `retargeted:
  false` alone cannot answer "why is this PR still on the default branch?".
- **The opt-out label works in both directions.** `Project.labelStagingOptOut`
  (default `staging:opt-out`) keeps a PR off staging, and applied *after* a
  retarget it moves the PR back to the base it was opened against
  (`optOutRequestsRevert` + the revert half of `applyStagingRouting`, outcomes
  `opt_out_reverted` / `revert_impossible`). Only PRs the bot moved are moved
  back: every successful retarget writes a `StagingRetarget` row (repo + PR ->
  `fromBase`), and no row means the PR reached staging some other way and is
  left alone. Do not replace that row with "the base is staging", which would
  redirect a PR opened against staging on purpose at the default branch. The
  row is its own table because retargeting runs *before* the gate, so there is
  no `PrCheck` row yet on `opened`. Removing the label routes the PR again on
  the spot rather than at its next push, which is the only reason
  `handlePullRequestEvent` handles `unlabeled` at all: it recognizes that one
  label and nothing else there, because the bot removes its own `labelEvaluate`
  after every re-eval and re-gating on that echo would loop. Both label paths
  route only and never reach the gate: a label the contributor cannot set says
  nothing about the contributor.
- `already_in_staging`: GitHub rejects a base change that would leave the PR
  with an empty diff (422, "no new commits between"), which happens when the
  head branch was already merged into staging by an earlier PR. Such a PR can
  never be retargeted and will bypass the batch if merged. Nothing in the bot
  can prevent that, so it is logged as a named warning rather than a stack
  trace.
- The two staging labels live **outside** the `contribution:` namespace on
  purpose: `setLabels` strips every `contribution:*` label the gate did not just
  set, so a staging label there would be wiped by the next converge.
  `updateLabelSettings` rejects the prefix.

QA on the staging batch (`src/lib/qa/`, App mode only):
- The manifest says what a release ships; the QA record says whether anyone has
  verified it. `syncBatchRecord` builds one `StagingBatchItem` per merged PR
  from the `PrSummary` objects `reconcileStagingBatch` **already holds**
  (`listPullRequests` returns titles, bodies, labels and merge SHAs whether we
  read them or not), so the whole feature costs no extra GitHub call. That is
  why `selectBatchEntries` is now a `.map()` over `selectBatchPrs`: both halves
  read one membership decision, so the board and the manifest cannot disagree
  about what is in the batch.
- **A reconcile never overwrites a verdict.** `qaStatus` / `qaById` / `qaAt` /
  `qaNotes` are human input; everything else on the row is re-derived on every
  pass. The single exception is a changed `mergeCommitSha`, which means the PR
  was merged again and the code in staging is not the code anyone tested, so the
  verdict resets to pending with a `qa.item_reset` audit. Without the exception
  the release PR states something false; without the rule a push to the default
  branch erases a morning of testing.
- **Items that leave the batch are marked `droppedAt`, never deleted.** A merge
  that reaches the default branch by another route stops shipping here, but the
  verdict somebody recorded against it is still worth keeping, and it comes back
  if the item does.
- **`wasGreen && added > 0` is the alert worth having.** New work landing in a
  batch that was already fully verified is the accident this exists to stop: the
  release looked ready, somebody merged one more PR, and nothing on GitHub says
  the answer changed. It drives `qa.items_added`.
- **A PR body edit re-derives the record.** `handlePullRequestEvent` lets
  `edited` through when `changes.body` is present, because the `## QA` section
  is routinely written *after* the PR merged and that event is the only signal
  that it changed. It cannot echo the bot's own writes: the only body the bot
  edits is the aggregate PR's, whose base is the default branch, so
  `touchesStaging` is false for it and no reconcile is signalled.
- **No per-PR file lists.** Classifying each PR's files through the digest's
  `GROUPS` would cost one `GET /pulls/{n}/files` per PR per reconcile, which on
  a thirty-PR batch reconciled on every push is a rate-limit incident. The
  batch-level digest already answers "what risky files does this ship".
- Statuses are `QA_`-prefixed in `src/lib/ui/status.ts` on purpose: bare
  `PENDING` already renders as "Not applied" and `APPROVED`/`DENIED` are
  application verdicts, so sharing them would corrupt the map for every page.
- `qaEnabled` resolves through `resolveStagingConfig` gated on `batchPrEnabled`,
  exactly like `digestEnabled`: the batch is the unit of QA. `qaCheckEnabled` is
  a **second, separate** switch, because turning QA on to see the state must not
  start failing a required check on a project that never asked to be gated.
- **Label state is tracked on the row** (`qaLabelApplied` on both the item and
  the batch). Reconciles run on every push, so recomputing labels by listing or
  by unconditionally issuing add/remove would cost calls per PR every time; the
  comparison makes the steady state free, which is the same bargain the body
  PATCH makes by diffing first. A failed call leaves the flag unset so the next
  pass retries.
- The QA section renders **last** inside the existing `staging-batch` markers,
  and must stay deterministic (sorted, capped, notes flattened) for the same
  reason the digest must: it is compared before the body is PATCHed, so any
  instability turns every reconcile into a visible edit on the release PR.

External QA boards (`src/lib/qa/board/`, Notion and Trello, two-way):
- Built as a **reconciling poll that webhooks only hurry along**, not an event
  handler with a poll bolted on. Notion gives an integration no per-database
  webhook at all and a Trello hook can be deleted out from under us, so the poll
  is what actually guarantees delivery; a late, duplicated or unverifiable
  callback then costs latency and never state. Same philosophy as "re-derived on
  every run, so a dropped webhook cannot leave it stale".
- **Loop safety is the `externalHash`.** Push writes a card, the provider fires
  a change, the pull reads it back, the push fires again. It is broken the same
  way the PR body avoids edit storms: write only when the rendered content
  actually changed. A pull that applies a verdict also *settles* the hash to
  what a push would now send, so reading a card never causes a write back to it.
  In the other direction the pull applies a change only when it decodes to a
  **different** status than the one held locally. One side needs a hash
  mismatch, the other a status difference, so neither can drive the other.
- Conflicts are last-writer-wins on timestamp, and a tie goes to us: local is
  the side with an audit trail and a named user. An externally-sourced verdict
  is audited with `actorId: null` and lands in `qaByExternal`, never in `qaById`.
- Credentials are plain columns on `QaBoardLink` (the `ProjectWebhook.secret`
  precedent) read only inside the sync, so they never enter workflow history and
  never reach a client component.
- Trello models status as **list membership**, not labels, because dragging a
  card between columns is what people actually do on a QA board. `targetId` is
  the board id and the status map holds list names, which are created on demand.

GitHub side effects (all Octokit calls):
- `src/lib/github/pr-actions.ts`: close/reopen, labels, comments, Check Runs
- `src/lib/github/check-run.ts`: `buildDecisionCheckPayload` (pure mapping)
  and `publishDecisionCheck` (App-mode publisher with feature-detect)
- `src/lib/github/collaborators.ts`: LRU-cached collaborator probe

QA modules:
- `src/lib/qa/types.ts`: the `QaStatus` union and the counting helpers
- `src/lib/qa/extract.ts`: pure `## QA` / closing-keyword / summary extraction
- `src/lib/qa/batch-record.ts`: derive and persist the batch, preserve verdicts
- `src/lib/qa/render.ts`: the PR body block and `buildQaCheckPayload`
- `src/lib/qa/labels.ts`: the failure label on both PRs, diffed before writing
- `src/lib/qa/board/`: the Notion and Trello adapters and the two-way sync

Quality (heuristic-only, no LLMs):
- `src/lib/quality/types.ts`: `Heuristic`, `PrContext`, `SignalsRaw`
- `src/lib/quality/registry.ts`: heuristic catalog + project config helpers
- `src/lib/quality/score.ts`: pure score formula; reads stored signals
- `src/lib/quality/fetch.ts`: App-mode PR/files/commits/account fetching
- `src/lib/quality/run.ts`: `runQualityForPrCheck` (App) and
  `runQualityFromContext` (CI)
- `src/lib/quality/heuristics/{size,prText,commits,code,account,diffCohesion}.ts`

Application lifecycle:
- `src/lib/applications/lifecycle.ts`: submission validation
- `src/lib/applications/decide.ts`: approve/deny/revoke + audit + notifications
- `src/lib/applications/schema.ts`: form-field schema + Zod validators

Audit, notifications, jobs:
- `src/lib/audit.ts`: `recordAudit` + `AuditKind` union (extend here when
  adding new audit kinds)
- `src/lib/notifications/{inbox,email,webhooks}.ts`
- **All background work is Temporal.** The old `JobQueue` table was dropped in
  `prisma/migrations/20260630120000_temporal_drop_legacy_queues`; there is no
  DB-polling runner to hook into. Start work via `src/lib/temporal/start.ts`
  with a deterministic id from `workflowIds` (`src/lib/temporal/task-queue.ts`),
  add the activity under `src/worker/activities/`, and register the workflow in
  `src/worker/workflows/index.ts`. Entity workflows: `projectGate` ->
  `contributorGate` -> `prGate`, plus the per-repo `stagingBatch`.
  `src/lib/temporal/contracts.ts` must stay import-light (types and plain
  constants only) because it is bundled into the deterministic workflow bundle.

## Conventions

- **Prefer editing existing files**. Don't create new modules unless the
  responsibility doesn't fit anywhere existing.
- **Server actions** live next to the page that uses them, in `actions.ts`.
- **JSON columns are strings.** Always parse via the helpers in
  `src/lib/quality/registry.ts` (or write a Zod schema in
  `src/lib/*/schema.ts`). Never `JSON.parse` and trust the result.
- **Octokit calls** go through `getInstallationOctokit(installationId)`. When
  rate-limit-sensitive, cache results following the LRU pattern in
  `collaborators.ts`.
- **Side effects on PRs** (close/reopen/label/comment/check) should be
  idempotent. The existing pattern is to do them inline with try/catch and
  log warnings on failure. Failures must not crash the webhook handler.
- **Audit every admin-visible state change** via `recordAudit`. Add the
  matching string literal to `AuditKind` in `src/lib/audit.ts` first.
- **No LLM dependency in quality scoring.** All heuristics are deterministic
  and pure given a `PrContext`. Adding an LLM call here would re-architect
  the module and is intentionally out of scope.
- **Disable switch contract:** when `Project.checkerEnabled === false`,
  `decideForRepo` returns `APPROVED { bypassReason: "checker_disabled" }`.
  The webhook handler must NOT close the PR or apply pending/denied labels.
  Whether to create a `PrCheck` row is gated on `Project.trackWhenDisabled`.
- **Never use em-dashes** (the long dash, Unicode U+2014). Reformat the sentence
  so none is needed (a colon, comma, parentheses, or two sentences). This applies
  to code, comments, UI copy, and docs. The en-dash (U+2013) in numeric ranges
  like `0–100` is fine.
- **Commit regularly, one commit per feature.** Each commit should be a single
  logical change with a clear message. Don't batch unrelated changes together.
- **Never add AI attribution to commits.** Do not include a `Co-Authored-By:
  Claude` trailer, any other AI/Claude co-author, or a "Generated with" line in
  commit messages or PR descriptions.

## UI and design system

- **Tokens live in `src/app/globals.css`.** OKLCH values under `:root` and
  `.dark`, exposed to Tailwind through `@theme inline`. Because utilities
  compile to `var(--x)`, palette values can change without touching a single
  className. Add a token in both blocks *and* in `@theme inline`.
- **The accent is cobalt** (OKLCH hue 256). It is for links, focus rings, the
  primary button and active nav only. Green/amber/red are reserved for meaning.
- **Use the `-strong` label tokens on tonal surfaces.** `bg-success/12` with
  `text-success` fails WCAG AA; `text-success-strong` is the same hue moved to
  a lightness that passes. Badge and Alert already do this.
- **Dark mode is a `.dark` class**, set from the `cc-theme` cookie by the root
  layout and resolved for `system` by `src/app/theme-script.tsx` before paint.
  There is no `@media (prefers-color-scheme)` block; do not add one.
- **Status strings go through `src/lib/ui/status.ts`** (`<StatusBadge>`), and
  dates through `src/lib/ui/format.ts`. Do not write a local variant map or
  `.toISOString().slice(0, 10)` in a page. Both modules are JSX-free so they
  stay testable under the node-environment vitest config.
- **Selects and checkboxes stay native.** Nearly every one is inside a
  `<form action={serverAction}>` or the public application form, which must
  work with JS disabled. `ui/switch` is Radix and is only for booleans that
  apply immediately.
- **Marketing pages generate their artifacts from the real modules**:
  `buildDecisionMessage`, `buildDecisionCheckPayload` and `ALL_HEURISTICS`.
  Do not retype a bot comment or a heuristic list into a page; if the copy
  changes, the page should follow for free.
- `/for-contributors` is **load-bearing**: its URL is quoted in PR comments
  across other people's repositories. It must not move, 404, require auth, or
  depend on the database.

## Request cost

Every route is dynamic (`export const dynamic = "force-dynamic"` in the root
layout, which is load-bearing; see the comment there), so nothing is amortized
by a cache and per-request work is paid on every page view. Two rules follow:

- **Do not stack independent awaits.** The root layout issues `auth()`, the
  Hexclave app and `cookies()` together; the project layout issues
  `getProjectForViewer` and `getProjectPermissions` together; `resolveOrgRoles`
  issues its two permission reads and its team read together. Each of these was
  a serial chain in front of the first byte of every page.
- **Session and membership reads are memoized, not repeated.** See the
  `auth()` / `getProjectMembership` note under Auth & roles.

The Sentry sample rates are a deliberate exception: traces, node profiling,
browser profiling and Session Replay all stay hardcoded at 1.0 in
`src/sentry.*.config.ts` and `src/instrumentation-client.ts`. That is real
per-request and per-page-view cost (the V8 CPU profiler on every sampled
transaction; rrweb serializing and uploading the DOM of every page for every
visitor, with masking off), and it is accepted in exchange for full-fidelity
observability. Do not sample it down without asking.

## Auth & roles

- Login is Hexclave (`@hexclave/next`). `auth()` (`src/auth.ts`) reads the
  Hexclave cookie session, resolves it to the local `User` row by
  `stackUserId`, and returns the same `session.user` shape as before, so
  consumers and `requireSession()`/`requireProjectRole()` are unchanged.
- Onboarding gate: `requireSession()` redirects to `/welcome` until the user
  has a linked GitHub identity (`ghId`); `/welcome` forces a GitHub connect for
  non-GitHub signups. The `country` code is captured automatically in the
  background (Hexclave's best-effort geo `countryCode`, mirrored to
  `User.country` by `captureGeoCountry`) — the user is never prompted, and it is
  not gated on. Edge `middleware.ts` does a fast cookie-presence gate for
  `/dashboard` and `/admin`.
- **Onboarding must never require a connected-account OAuth token.** Hexclave
  issues none when its GitHub provider runs on shared OAuth keys: the
  `createProviderAccessToken` call fails. Both sides of `/welcome` therefore key
  on the provider LINK only: `syncGitHubIdentity` reads the numeric id from
  `listOAuthProviders()`'s `accountId`, and `WelcomeClient` checks
  `useOAuthProviders()` for `type === "github"`, calling `linkConnectedAccount`
  when it is missing. Do not reintroduce `useConnectedAccount` /
  `getConnectedAccount` / `useOrLinkConnectedAccount` here: those resolve a
  token, treat a perfectly good link as unconnected, and with `or: "redirect"`
  either bounce the user through GitHub forever or throw out of the render into
  `error.tsx`. That is what made sign-up impossible for real applicants, and it
  shows up as a client-side "Something went wrong" with **no digest**.
- `auth()` is memoized per request with React `cache()`. A page calls it from
  the root layout, `SiteHeader`, `requireSession()` and again from the page's
  `requireProjectRole()`; unmemoized, each call repeated the local-user lookup,
  the country capture and the role mirror write, and the Hexclave SDK only
  holds its own reads for ~5s. `getProjectMembership` is memoized for the same
  reason. `cookies()` inside a `cache()` scope is fine: Next only rejects it
  under `"use cache"` / `unstable_cache(...)`, which is a different scope
  type (see `dist/server/request/cookies.js`). An earlier revert blamed
  `cache()` for a sign-in loop; the wrapper now falls back to an uncached
  resolve if the memo is ever unavailable, so it cannot report a signed-in user
  as signed out.
- Org roles (super-admin, can-create-project) are **Hexclave project
  permissions** (`super_admin` / `create_project`) — Hexclave is the source of
  truth. `User.isSuperAdmin` / `User.canCreateProj` are mirror cache columns
  read on the hot path; reconciled on sign-in from `SUPER_ADMINS`/
  `PROJECT_CREATORS` (additive) and managed via `/admin/allowlist`, which
  grants/revokes the Hexclave permission. The operator must define these two
  project permissions in Hexclave.
- Per-project: `ProjectMember.role` ∈ {`OWNER`, `ADMIN`, `REVIEWER`} stays
  **local**. `requireProjectRole(projectId, minRole)` enforces this in server
  components and actions.
- Approval/denial requires REVIEWER. Settings/team/quality/people require
  ADMIN. Project deletion requires OWNER.
- The bot's GitHub App installation (`getInstallationOctokit`,
  `Repo.installationId`) is independent of login and unchanged.

## Adding a new quality heuristic

1. Drop a file in `src/lib/quality/heuristics/<group>.ts` exporting one or
   more `Heuristic` objects.
2. Add it to `ALL_HEURISTICS` in `src/lib/quality/registry.ts`.
3. The settings UI auto-renders the new heuristic in its group. The score
   formula and storage are unchanged. The heuristic id appears in
   `PrQuality.signalsRaw` after the next run.
4. No DB migration needed.

## Operational runbook

```bash
pnpm install
pnpm db:migrate          # applies pending Prisma migrations
pnpm dev                 # http://localhost:3000
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest
pnpm test:watch
pnpm test:e2e            # Playwright
pnpm build && pnpm start
```

DBs:

- Dev: `data/contribution-checker.db`
- Tests: `data/test.db` (configured in `vitest.config.ts`)

Manual GitHub App setup is documented in-app at `/admin/setup`. The required
permissions are listed there; `checks:write` is required for status checks
and `contents:read` is required for PR Quality scoring (file diff fetching).

## Don'ts

- Don't run GitHub side effects from background tasks outside Temporal. The
  webhook path uses inline awaits inside an activity; anything else starts a
  workflow via `src/lib/temporal/start.ts`.
- Don't `JSON.parse` JSON columns without a Zod schema or a parsing helper.
- Don't add an LLM dependency to quality scoring (see Conventions).
- Don't let webhook errors propagate up. GitHub will retry forever and the
  delivery will look "failed". Log and return 200 unless signature
  verification fails.
- Don't introduce per-installation tokens in the database. Always derive via
  `getInstallationOctokit`.

## Known gaps / follow-ups

- Staging routing is App mode only. CI mode (`src/lib/ci/check-pr-core.ts` and
  the generated workflow YAML) neither retargets nor maintains a batch PR. QA
  rides on the batch, so it is App mode only for the same reason.
- QA verdicts are recorded on the dashboard or on a linked Notion/Trello board.
  There is deliberately no PR-body checkbox or `/qa` comment surface: the
  aggregate PR's `pull_request.edited` body changes are short-circuited in
  `handlePullRequestEvent`, and no `issue_comment` event is subscribed.
- A Trello board's cards are read in full on every poll, because Trello has no
  server-side "changed since" filter for cards. That is one request per board
  per interval, which is fine for a board holding one release, and would want
  revisiting for a board holding a year of them.
- Retargeting only reaches existing open PRs through `reGateProjectPrs`, which
  fans out over `PrCheck` rows. PRs with no row (opened before the App was
  installed) retarget on their next event instead.
- If a repo's default branch is protected by a merge queue or required reviews
  and the staging branch is not, retargeting routes contributions around those
  rules and the aggregate PR becomes the only gate. Replicate the protection
  onto the staging branch.
- CI mode quality scoring depends on the workflow including `qualityContext`
  in the request body. Older workflow files may not have this; users need to
  copy the latest YAML from `/dashboard/projects/<id>/repos`.
- Backfill is capped at 200 rows per run to bound API usage. Re-run for
  larger projects or write a worker.
